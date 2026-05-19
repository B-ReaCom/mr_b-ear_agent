// Mr. B-EAR Chat API - Server-side proxy with rate limiting
// Vercel Edge Function

export const config = {
  runtime: 'edge',
};

// ===== レート制限設定 =====
// 注：本格運用には Vercel KV 化が中期目標
// （現状はインメモリのため、Edge Function インスタンスごとに独立カウント）
const RATE_LIMITS = {
  perMinute: 5,      // 1分間に5リクエストまで
  perHour: 50,       // 1時間に50リクエストまで
  perDay: 50,        // 1日に50リクエストまで（コスト攻撃対策で 200 → 50 に引き下げ）
};

// ===== リクエストボディ検証用設定 =====
// 許可するモデル（不正モデルでコスト攻撃を防ぐ）
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5'
]);
const MAX_TOKENS_LIMIT = 3000;
const MAX_MESSAGES_TOTAL_LEN = 50000;

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

// ===== リード判定（高優先度のみ通知） =====
// スコア >= 8 を通知発火条件とする
function detectLead(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { score: 0, isHighPriority: false, detectedKeywords: [], detectedInfo: {} };
  }

  // 顧客（user）の発言のみを判定対象にする
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

  // 高優先度キーワード（最低1つマッチで +3 × 個数）
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

  // メールアドレス
  const emailMatch = userMessages.match(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    score += 5;
    detectedInfo.email = emailMatch[0];
  }

  // 電話番号（0X-XXXX-XXXX 形式）
  const phoneMatch = userMessages.match(/0\d{1,4}[-(]\d{1,4}[-)]\d{4}/);
  if (phoneMatch) {
    score += 5;
    detectedInfo.phone = phoneMatch[0];
  }

  // 会社名らしき文字列
  if (/株式会社|有限会社|合同会社|co\.,\s*ltd|inc\.|corp\./i.test(userMessages)) {
    score += 3;
    detectedInfo.companyDetected = true;
  }

  // 数字+単位（人数・台数・名・個）
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

// LINE WORKS 通知用のメッセージを組み立てる
function formatLeadMessage(leadInfo, messages, sessionId) {
  const now = new Date();
  // YYYY-MM-DD HH:MM (UTC) 形式
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 16);

  // 最新の user メッセージを「顧客の発言」として表示
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

// 内部 fetch 用のベース URL を決定（Vercel 上では絶対 URL が必要）
function getBaseUrl(req) {
  // Vercel が VERCEL_URL を提供する（プロトコルなし）
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  // フォールバック：リクエスト Host から組み立てる
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

    // ===== リクエストボディ検証（コスト攻撃対策） =====
    // モデル検証
    if (!ALLOWED_MODELS.has(body.model)) {
      return new Response(JSON.stringify({
        error: 'invalid_model',
        message: '指定されたモデルは許可されていません。'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // max_tokens 検証
    const maxTok = body.max_tokens | 0;
    if (maxTok < 1 || maxTok > MAX_TOKENS_LIMIT) {
      return new Response(JSON.stringify({
        error: 'invalid_max_tokens',
        message: `max_tokens は 1〜${MAX_TOKENS_LIMIT} の範囲で指定してください。`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // メッセージ総文字数の検証
    const totalLen = (body.messages || []).reduce((n, m) => {
      if (typeof m.content === 'string') return n + m.content.length;
      return n + JSON.stringify(m.content || '').length;
    }, 0);
    if (totalLen > MAX_MESSAGES_TOTAL_LEN) {
      return new Response(JSON.stringify({
        error: 'message_too_long',
        message: `メッセージの総文字数が上限（${MAX_MESSAGES_TOTAL_LEN}文字）を超えています。`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

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

    // ===== リード自動通知（高優先度のみ） =====
    // AI 応答完了後にバックグラウンドで判定 → LINE WORKS Bot へ通知
    // ファイア＆フォーゲット：通知失敗しても顧客のレスポンスには影響なし
    try {
      const leadInfo = detectLead(body.messages || []);
      if (leadInfo.isHighPriority) {
        const messageText = formatLeadMessage(leadInfo, body.messages || [], body.session_id || body.sessionId);
        const notifyUrl = `${getBaseUrl(req)}/api/lineworks-notify`;
        // 非同期で発火、結果は待たない（顧客への応答を遅延させない）
        // 顧客の個人情報はログに残さない（成否のみログ）
        fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageText }),
        })
          .then(r => {
            if (!r.ok) console.error('[chat.js] lineworks notify non-ok:', r.status);
          })
          .catch(err => console.error('[chat.js] lineworks notify failed:', err && err.message ? err.message : err));
      }
    } catch (err) {
      // リード判定でエラーが出ても顧客の体験には影響させない
      console.error('[chat.js] lead detection error:', err && err.message ? err.message : err);
    }

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error) {
    // 詳細エラーはサーバーログのみに（クライアントに内部情報を漏らさない）
    console.error('[chat.js] internal error:', error);
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: 'システムエラーが発生しました。しばらく経ってからお試しください。'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
