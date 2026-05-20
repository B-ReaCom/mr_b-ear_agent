// Mr. B-EAR Chat API - Server-side proxy with rate limiting
// Vercel Edge Function

export const config = {
  runtime: 'edge',
};

// ===== レート制限設定 =====
const RATE_LIMITS = {
  perMinute: 5,      // 1分間に5リクエストまで
  perHour: 50,       // 1時間に50リクエストまで
  perDay: 200,       // 1日に200リクエストまで
};

// ===== Origin 許可リスト（CSRF対策） =====
// 自社ドメインからのリクエストのみ許可
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/mr-b-ear-agent\.vercel\.app$/,           // 本番ドメイン
  /^https:\/\/mr-b-ear-agent-[\w-]+\.vercel\.app$/,    // Vercel プレビュー
  /^https:\/\/[\w-]+\.bearidge\.com$/,                  // ベアリッジ系
  /^https:\/\/bearidge\.com$/,
  /^http:\/\/localhost(:\d+)?$/,                        // ローカル開発
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(req) {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  // Origin ヘッダーが優先
  if (origin) {
    return ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
  }
  // Origin がない場合は Referer をチェック
  if (referer) {
    return ALLOWED_ORIGIN_PATTERNS.some(p => {
      // Referer は完全URLなので、ホスト部分のみマッチング
      try {
        const url = new URL(referer);
        return p.test(url.origin);
      } catch {
        return false;
      }
    });
  }
  // どちらもない場合はブロック（直接 curl などからのアクセスを防止）
  return false;
}

// インメモリ・レート制限ストア（Edge Function インスタンスごと）
// 注：本格運用にはVercel KVまたはUpstash Redisの利用を推奨
const rateLimitStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : (req.headers.get('x-real-ip') || 'unknown');
}

function checkRateLimit(ip) {
  const now = Date.now();
  let record = rateLimitStore.get(ip);

  if (!record) {
    record = {
      minute: { count: 0, start: now },
      hour: { count: 0, start: now },
      day: { count: 0, start: now },
    };
  }

  // ウィンドウのリセット
  if (now - record.minute.start > 60 * 1000) {
    record.minute = { count: 0, start: now };
  }
  if (now - record.hour.start > 60 * 60 * 1000) {
    record.hour = { count: 0, start: now };
  }
  if (now - record.day.start > 24 * 60 * 60 * 1000) {
    record.day = { count: 0, start: now };
  }

  // 上限チェック
  if (record.minute.count >= RATE_LIMITS.perMinute) {
    return { allowed: false, reason: `1分間のリクエスト上限（${RATE_LIMITS.perMinute}件）に達しました。しばらくお待ちください。`, retryAfter: 60 };
  }
  if (record.hour.count >= RATE_LIMITS.perHour) {
    return { allowed: false, reason: `1時間のリクエスト上限（${RATE_LIMITS.perHour}件）に達しました。1時間後にお試しください。`, retryAfter: 3600 };
  }
  if (record.day.count >= RATE_LIMITS.perDay) {
    return { allowed: false, reason: `本日のリクエスト上限（${RATE_LIMITS.perDay}件）に達しました。明日お試しください。`, retryAfter: 86400 };
  }

  // カウントアップ
  record.minute.count++;
  record.hour.count++;
  record.day.count++;
  rateLimitStore.set(ip, record);

  return { allowed: true };
}

// Mr. B-EAR 利用ログ記録用（Google Apps Script へ送信）
// 月間使用量集計・¥20,000超過時のメール通知に使用
const USAGE_LOG_URL = 'https://script.google.com/macros/s/AKfycbz0Jm2Fc_7pimlmmjGaH2CP_wkQL8MQWsthm0_BBKMOHXIRrdE-lqyTOaDhDT6tRazM/exec';

async function logUsage(data) {
  try {
    await fetch(USAGE_LOG_URL, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  } catch (e) {
    // ログ送信失敗は無視（API応答に影響させない）
  }
}

// Anthropic API トークンコストの推定
function estimateCost(usage, model) {
  if (!usage) return 0;
  // Sonnet 4.6: $3/MTok input, $15/MTok output
  // Haiku 4.5: $1/MTok input, $5/MTok output
  // Cache: write +25%, read -90%
  const rates = {
    'claude-sonnet-4-6':   { in: 3,  out: 15, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-haiku-4-5':    { in: 1,  out: 5,  cacheWrite: 1.25, cacheRead: 0.10 },
    'claude-opus-4-7':     { in: 5,  out: 25, cacheWrite: 6.25, cacheRead: 0.50 }
  };
  const r = rates[model] || rates['claude-sonnet-4-6'];
  const inputTokens = (usage.input_tokens || 0);
  const cacheWriteTokens = (usage.cache_creation_input_tokens || 0);
  const cacheReadTokens = (usage.cache_read_input_tokens || 0);
  const outputTokens = (usage.output_tokens || 0);

  const costUSD = (inputTokens * r.in + cacheWriteTokens * r.cacheWrite + cacheReadTokens * r.cacheRead + outputTokens * r.out) / 1_000_000;
  return costUSD;
}

// ===== LINE WORKS 直接通知（Edge Function 内で完結） =====
async function sendLineWorksDirectNotification(messageText) {
  const clientId = process.env.LINE_WORKS_CLIENT_ID;
  const clientSecret = process.env.LINE_WORKS_CLIENT_SECRET;
  const serviceAccount = process.env.LINE_WORKS_SERVICE_ACCOUNT;
  const privateKeyPem = (process.env.LINE_WORKS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const botId = process.env.LINE_WORKS_BOT_ID;
  const userId = process.env.LINE_WORKS_NOTIFY_USER_ID;

  if (!clientId || !clientSecret || !serviceAccount || !privateKeyPem || !botId || !userId) {
    console.error('[lineworks-direct] Missing env vars');
    return;
  }

  try {
    // JWT 生成（Web Crypto API - Edge Function対応）
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iss: clientId, sub: serviceAccount, iat: now, exp: now + 3600 };

    const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const signingInput = `${b64url(header)}.${b64url(payload)}`;

    // PEM → PKCS8 バイナリ
    const pemBody = privateKeyPem
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
      .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
      .replace(/\s/g, '');
    const derBuffer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0)).buffer;

    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', derBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
    const sigBuffer = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', cryptoKey,
      new TextEncoder().encode(signingInput)
    );
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const jwt = `${signingInput}.${sig}`;

    // アクセストークン取得
    const tokenRes = await fetch('https://auth.worksmobile.com/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        assertion: jwt,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'bot bot.message',
      }).toString(),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('[lineworks-direct] Token failed:', tokenRes.status);
      return;
    }
    console.log('[lineworks-direct] Token acquired');

    // メッセージ送信
    const msgRes = await fetch(
      `https://www.worksapis.com/v1.0/bots/${botId}/users/${userId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: { type: 'text', text: messageText } }),
      }
    );
    console.log('[lineworks-direct] Message sent, status:', msgRes.status);
  } catch (err) {
    console.error('[lineworks-direct] Error:', err?.message || err);
  }
}

// ===== リード判定（高優先度のみ通知） =====
// スコア >= 8 を通知発火条件とする
function detectLead(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { score: 0, isHighPriority: false, detectedKeywords: [], detectedInfo: {} };
  }

  const userMessages = messages
    .filter(m => m && m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
    .join('\n');

  if (!userMessages.trim()) {
    return { score: 0, isHighPriority: false, detectedKeywords: [], detectedInfo: {} };
  }

  let score = 0;
  const detectedKeywords = [];
  const detectedInfo = {};

  const highPriorityKeywords = [
    '見積', '見積もり', 'お見積り', 'quote', 'quotation', 'estimate',
    '導入', '採用', '購入', '買いたい', 'ほしい', 'purchase', 'buy', 'order',
    '電話', '連絡先', 'contact', 'call', '電話番号',
    '商談', '打ち合わせ', 'meeting', 'appointment',
    'いつから', '来月', '年内', '今月', 'すぐ', 'asap',
    '予算', 'budget',
  ];

  const lowerText = userMessages.toLowerCase();
  for (const kw of highPriorityKeywords) {
    if (lowerText.includes(kw.toLowerCase())) {
      score += 3;
      detectedKeywords.push(kw);
    }
  }

  const emailMatch = userMessages.match(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    score += 5;
    detectedInfo.email = emailMatch[0];
  }

  const phoneMatch = userMessages.match(/0\d{1,4}[-(]\d{1,4}[-)]\d{4}/);
  if (phoneMatch) {
    score += 5;
    detectedInfo.phone = phoneMatch[0];
  }

  if (/株式会社|有限会社|合同会社|co\.,\s*ltd|inc\.|corp\./i.test(userMessages)) {
    score += 3;
    detectedInfo.companyDetected = true;
  }

  const numUnitMatch = userMessages.match(/(\d+)\s*[人台名個]/);
  if (numUnitMatch) {
    score += 2;
    detectedInfo.scale = numUnitMatch[0];
  }

  return {
    score,
    isHighPriority: score >= 8,
    detectedKeywords,
    detectedInfo,
  };
}

function formatLeadMessage(leadInfo, messages, sessionId) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const timestamp = jst.toISOString().replace('T', ' ').substring(0, 16);

  const lastUserMsg = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === 'user') {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        return c.substring(0, 300);
      }
    }
    return '';
  })();

  let msg = `🔥 新規リード発生 (${timestamp})\n\n`;
  msg += `【顧客の発言】\n${lastUserMsg}\n\n`;
  msg += `【検出情報】\n`;

  if (leadInfo.detectedInfo.email) msg += `- メールアドレス: ${leadInfo.detectedInfo.email}\n`;
  if (leadInfo.detectedInfo.phone) msg += `- 電話番号: ${leadInfo.detectedInfo.phone}\n`;
  if (leadInfo.detectedInfo.companyDetected) msg += `- 会社名: 検出されました\n`;
  if (leadInfo.detectedInfo.scale) msg += `- 規模: ${leadInfo.detectedInfo.scale}\n`;
  if (leadInfo.detectedKeywords && leadInfo.detectedKeywords.length > 0) {
    msg += `- 検出キーワード: ${leadInfo.detectedKeywords.slice(0, 8).join(', ')}\n`;
  }

  msg += `\n【スコア】${leadInfo.score} (高優先度)\n`;

  if (sessionId) {
    msg += `\n【会話 URL】\nhttps://mr-b-ear-agent.vercel.app/?session=${encodeURIComponent(sessionId)}\n`;
  }

  return msg;
}

function getBaseUrl(req) {
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  const host = req.headers.get('host');
  if (host) {
    const proto = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
    return `${proto}://${host}`;
  }
  return 'https://mr-b-ear-agent.vercel.app';
}

// CORS ヘッダーを動的に決定（Originが許可リストにあればその値、なければ拒否）
function buildCorsHeaders(req) {
  const origin = req.headers.get('origin') || '';
  const isAllowed = ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

export default async function handler(req) {
  const corsHeaders = buildCorsHeaders(req);

  // CORS プリフライト
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // ===== Origin 検証（CSRF対策・他サイトからのAPI叩き防止） =====
  if (!isAllowedOrigin(req)) {
    return new Response(JSON.stringify({
      error: 'forbidden_origin',
      message: '許可されていないオリジンからのアクセスです。'
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // ===== レベル5：サーバー側レート制限 =====
  const ip = getClientIp(req);
  const rateLimitResult = checkRateLimit(ip);

  if (!rateLimitResult.allowed) {
    return new Response(JSON.stringify({
      error: 'rate_limit_exceeded',
      message: rateLimitResult.reason,
      retryAfter: rateLimitResult.retryAfter
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimitResult.retryAfter),
        ...corsHeaders
      }
    });
  }

  // ===== API キーチェック =====
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'server_not_configured',
      message: 'ANTHROPIC_API_KEY が設定されていません。Vercel ダッシュボードで環境変数を設定してください。'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  try {
    const body = await req.json();
    const isStream = body.stream === true;

    // Anthropic API へ転送
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body)
    });

    // ===== ストリーミング応答（SSE） =====
    if (isStream && upstream.ok && upstream.body) {
      // ストリームを2分岐：1つはクライアントへ、もう1つは使用量ログ収集用
      const [streamForClient, streamForLog] = upstream.body.tee();

      // バックグラウンドで使用量を集計 + リード検出通知
      (async () => {
        const reader = streamForLog.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let usage = null;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const event = JSON.parse(payload);
                if (event.type === 'message_start' && event.message && event.message.usage) {
                  usage = { ...event.message.usage };
                } else if (event.type === 'message_delta' && event.usage) {
                  usage = { ...(usage || {}), ...event.usage };
                }
              } catch {}
            }
          }
        } catch {}
        if (usage) {
          const cost = estimateCost(usage, body.model);
          logUsage({
            type: 'api_usage',
            ip: ip,
            model: body.model,
            usage: usage,
            cost_usd: cost,
            timestamp: new Date().toISOString()
          });
        }
        // ===== リード検出・通知（ストリーム完了後） =====
        try {
          const sid = body.session_id || body.sessionId || '';
          const leadInfo = detectLead(body.messages || []);
          if (leadInfo.isHighPriority) {
            const messageText = formatLeadMessage(leadInfo, body.messages || [], sid);
            await sendLineWorksDirectNotification(messageText);
          }
        } catch (err) {
          console.error('[chat.js] lead notification error:', err?.message || err);
        }
      })();

      return new Response(streamForClient, {
        status: upstream.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          ...corsHeaders
        }
      });
    }

    // ===== 非ストリーミング応答（従来パス） =====
    const data = await upstream.json();

    // 使用量ログ送信（非同期、失敗してもOK）
    if (data.usage) {
      const cost = estimateCost(data.usage, body.model);
      logUsage({
        type: 'api_usage',
        ip: ip,
        model: body.model,
        usage: data.usage,
        cost_usd: cost,
        timestamp: new Date().toISOString()
      });
    }

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: error.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
