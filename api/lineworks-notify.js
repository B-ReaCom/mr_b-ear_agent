// Mr. B-EAR - LINE WORKS Bot 通知エンドポイント
// Vercel Node.js Runtime（JWT 署名に Node.js の crypto モジュールが必要なため）
//
// このエンドポイントは chat.js から内部的に呼び出され、
// 高優先度リードが検出された場合に LINE WORKS のトークルームへ通知する。

export const config = { runtime: 'nodejs' };

import crypto from 'crypto';

// ===== 環境変数 =====
// LINE_WORKS_CLIENT_ID         : Developer Console の Client App の Client ID
// LINE_WORKS_CLIENT_SECRET     : 同 Client Secret
// LINE_WORKS_SERVICE_ACCOUNT   : サービスアカウント ID (例: xxx.serviceaccount@domain)
// LINE_WORKS_PRIVATE_KEY       : Service Account の Private Key（PEM 形式の文字列、改行は \n でもOK）
// LINE_WORKS_BOT_ID            : Bot ID
// LINE_WORKS_DOMAIN_ID         : ドメイン ID（ログ用、必須ではない）
// LINE_WORKS_CHANNEL_ID        : 通知先トークルームの Channel ID

const LINE_WORKS_TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';

// ===== Origin 許可リスト（chat.js と同じパターンを使用） =====
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/mr-b-ear-agent\.vercel\.app$/,
  /^https:\/\/mr-b-ear-agent-[\w-]+\.vercel\.app$/,
  /^https:\/\/[\w-]+\.bearidge\.com$/,
  /^https:\/\/bearidge\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(req) {
  // Node.js Runtime のリクエストは req.headers がオブジェクト
  const origin = req.headers.origin || req.headers.Origin;
  const referer = req.headers.referer || req.headers.Referer;

  // サーバー内部からの呼び出し（chat.js からの fetch）の場合、
  // Vercel 内部呼び出しではヘッダー x-vercel-internal が付くことがあるため
  // それを許可（または同一 host へのループバックを許可）
  const host = req.headers.host || '';
  if (origin && new URL(`http://x/`).host) {
    // noop, just to ensure URL is available
  }

  if (origin) {
    return ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
  }
  if (referer) {
    try {
      const url = new URL(referer);
      return ALLOWED_ORIGIN_PATTERNS.some(p => p.test(url.origin));
    } catch {
      return false;
    }
  }

  // Origin も Referer もない場合は、サーバー内部からの呼び出しとみなして許可
  // （chat.js からの fire-and-forget fetch は Origin を持たない）
  // ただし host ヘッダーが Vercel ドメインまたは localhost であることを確認する
  if (host) {
    if (/^mr-b-ear-agent[\w.-]*\.vercel\.app$/.test(host)) return true;
    if (/^localhost(:\d+)?$/.test(host)) return true;
    if (/^127\.0\.0\.1(:\d+)?$/.test(host)) return true;
    if (/\.bearidge\.com$/.test(host)) return true;
  }
  return false;
}

// ===== JWT 作成 + Token 取得 =====
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: process.env.LINE_WORKS_CLIENT_ID,
    sub: process.env.LINE_WORKS_SERVICE_ACCOUNT,
    iat: now,
    exp: now + 3600,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  // PEM 形式の Private Key（環境変数で \n をリテラルで保存している場合に対応）
  const privateKey = (process.env.LINE_WORKS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new Error('LINE_WORKS_PRIVATE_KEY is not a valid PEM');
  }

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(privateKey, 'base64url');

  const jwt = `${signingInput}.${signature}`;

  const params = new URLSearchParams({
    assertion: jwt,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: process.env.LINE_WORKS_CLIENT_ID,
    client_secret: process.env.LINE_WORKS_CLIENT_SECRET,
    scope: 'bot bot.message',
  });

  const response = await fetch(LINE_WORKS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error('Token response missing access_token');
  }
  return data.access_token;
}

// ===== LINE WORKS のトークルームへメッセージ送信 =====
async function sendLineWorksMessage(accessToken, messageText) {
  const botId = process.env.LINE_WORKS_BOT_ID;
  const channelId = process.env.LINE_WORKS_CHANNEL_ID;
  const url = `https://www.worksapis.com/v1.0/bots/${botId}/channels/${channelId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: {
        type: 'text',
        text: messageText,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Message send failed: ${response.status} ${errorText}`);
  }

  // 204 No Content の場合があるので、JSON は best-effort
  try {
    return await response.json();
  } catch {
    return { ok: true };
  }
}

// ===== Node.js リクエストボディを安全に読み込む =====
async function readJsonBody(req) {
  // Vercel の Node.js runtime では req.body が自動 parse されていることが多いが、
  // ストリームから読み込まないと取得できない場合もあるため両対応する
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Origin 検証（外部からの直接叩き防止）
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ error: 'forbidden_origin' });
  }

  // ===== 環境変数チェック =====
  const requiredEnvs = [
    'LINE_WORKS_CLIENT_ID',
    'LINE_WORKS_CLIENT_SECRET',
    'LINE_WORKS_SERVICE_ACCOUNT',
    'LINE_WORKS_PRIVATE_KEY',
    'LINE_WORKS_BOT_ID',
    'LINE_WORKS_CHANNEL_ID',
  ];
  const missing = requiredEnvs.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('[lineworks-notify] Missing env vars:', missing);
    return res.status(503).json({ error: 'not_configured', missing });
  }

  try {
    const body = await readJsonBody(req);
    const messageText = body && body.messageText;
    if (!messageText || typeof messageText !== 'string') {
      return res.status(400).json({ error: 'missing_messageText' });
    }

    // 文字数の上限（暴走防止・LINE WORKS の制限対応）
    const safeText = messageText.length > 2000 ? messageText.substring(0, 2000) + '...' : messageText;

    const accessToken = await getAccessToken();
    await sendLineWorksMessage(accessToken, safeText);

    return res.status(200).json({ ok: true });
  } catch (error) {
    // ログにはエラー詳細を残すが、レスポンスには漏らさない
    console.error('[lineworks-notify] Error:', error && error.message ? error.message : error);
    return res.status(500).json({ error: 'notification_failed' });
  }
}
