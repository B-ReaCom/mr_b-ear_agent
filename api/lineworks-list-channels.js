// Mr. B-EAR - LINE WORKS Bot が属するチャンネル一覧を取得するヘルパー API
// 用途: Channel ID を環境変数に設定する前に、Bot がトークルームに招待された後で
//       「どの Channel ID をセットすればいいか」をブラウザから確認するための一時 API。
//
// アクセス方法: https://mr-b-ear-agent.vercel.app/api/lineworks-list-channels
//
// 必要な環境変数 (CHANNEL_ID 以外を Vercel に設定済みである必要がある):
//   LINE_WORKS_CLIENT_ID
//   LINE_WORKS_CLIENT_SECRET
//   LINE_WORKS_SERVICE_ACCOUNT
//   LINE_WORKS_PRIVATE_KEY
//   LINE_WORKS_BOT_ID

export const config = { runtime: 'nodejs' };

import crypto from 'crypto';

const LINE_WORKS_TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';

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
    scope: 'bot bot.message bot.read',
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

export default async function handler(req, res) {
  // 環境変数チェック（CHANNEL_ID は不要）
  const requiredEnvs = [
    'LINE_WORKS_CLIENT_ID',
    'LINE_WORKS_CLIENT_SECRET',
    'LINE_WORKS_SERVICE_ACCOUNT',
    'LINE_WORKS_PRIVATE_KEY',
    'LINE_WORKS_BOT_ID',
  ];
  const missing = requiredEnvs.filter(k => !process.env[k]);
  if (missing.length > 0) {
    return res.status(503).json({
      error: 'not_configured',
      missing,
      hint: 'Vercel の Environment Variables にこれらを設定してください',
    });
  }

  try {
    const accessToken = await getAccessToken();
    const botId = process.env.LINE_WORKS_BOT_ID;

    // 複数のエンドポイントを試す
    const endpoints = [
      `https://www.worksapis.com/v1.0/bots/${botId}/channels`,
      `https://www.worksapis.com/v1.0/bots/${botId}/joined`,
      `https://www.worksapis.com/v1.0/bots/${botId}/joinedChannels`,
      `https://www.worksapis.com/v1.0/channels`,
    ];

    const results = {};
    for (const url of endpoints) {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      results[url] = { status: response.status, data };
    }

    return res.status(200).json({ ok: true, botId, results });
  } catch (error) {
    console.error('[lineworks-list-channels] Error:', error && error.message ? error.message : error);
    return res.status(500).json({
      error: 'internal_error',
      message: error && error.message ? error.message : String(error),
    });
  }
}
