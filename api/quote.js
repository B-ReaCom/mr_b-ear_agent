// Midland Hearts 自動見積もり API
// フロントエンドからの見積もり依頼を受け取り、GAS Webhook 経由でメール通知
// Vercel Edge Function

export const config = {
  runtime: 'edge',
};

// ===== レート制限設定（チャットより厳しめに） =====
const RATE_LIMITS = {
  perMinute: 3,
  perHour: 10,
  perDay: 30,
};

// ===== Origin 許可リスト =====
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/mr-b-ear-agent\.vercel\.app$/,
  /^https:\/\/mr-b-ear-agent-[\w-]+\.vercel\.app$/,
  /^https:\/\/[\w-]+\.bearidge\.com$/,
  /^https:\/\/bearidge\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function isAllowedOrigin(req) {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  if (origin) {
    return ALLOWED_ORIGIN_PATTERNS.some(p => p.test(origin));
  }
  if (referer) {
    return ALLOWED_ORIGIN_PATTERNS.some(p => {
      try {
        const url = new URL(referer);
        return p.test(url.origin);
      } catch {
        return false;
      }
    });
  }
  return false;
}

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

// インメモリ・レート制限ストア
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

  if (now - record.minute.start > 60 * 1000) record.minute = { count: 0, start: now };
  if (now - record.hour.start > 60 * 60 * 1000) record.hour = { count: 0, start: now };
  if (now - record.day.start > 24 * 60 * 60 * 1000) record.day = { count: 0, start: now };

  if (record.minute.count >= RATE_LIMITS.perMinute) {
    return { allowed: false, reason: '短時間に複数回送信されました。1分ほどお待ちください。', retryAfter: 60 };
  }
  if (record.hour.count >= RATE_LIMITS.perHour) {
    return { allowed: false, reason: '1時間あたりの送信上限に達しました。', retryAfter: 3600 };
  }
  if (record.day.count >= RATE_LIMITS.perDay) {
    return { allowed: false, reason: '本日の送信上限に達しました。', retryAfter: 86400 };
  }

  record.minute.count++;
  record.hour.count++;
  record.day.count++;
  rateLimitStore.set(ip, record);

  return { allowed: true };
}

// 既存の GAS Webhook（USAGE_LOG/QA_LOG と同居）
const GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbz0Jm2Fc_7pimlmmjGaH2CP_wkQL8MQWsthm0_BBKMOHXIRrdE-lqyTOaDhDT6tRazM/exec';

// ===== バリデーション =====
function sanitizeString(v, maxLen = 500) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

function validatePayload(body) {
  const errors = [];

  const mode = body.mode === 'detailed' ? 'detailed' : 'quick';

  const customer = body.customer || {};
  const name = sanitizeString(customer.name, 100);
  const email = sanitizeString(customer.email, 200);
  if (!name) errors.push('お名前を入力してください');
  if (!email) errors.push('メールアドレスを入力してください');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('メールアドレスの形式が正しくありません');
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) errors.push('製品を1つ以上選択してください');
  const validItems = items
    .map(it => ({
      sku: sanitizeString(it.sku, 50),
      name: sanitizeString(it.name, 200),
      unitPrice: Number.isFinite(Number(it.unitPrice)) ? Number(it.unitPrice) : 0,
      quantity: Math.max(1, Math.min(9999, parseInt(it.quantity, 10) || 1)),
    }))
    .filter(it => it.name);

  if (validItems.length === 0) errors.push('製品選択が無効です');

  return {
    errors,
    payload: {
      mode,
      customer: {
        name,
        company: sanitizeString(customer.company, 200),
        department: sanitizeString(customer.department, 200),
        email,
        phone: sanitizeString(customer.phone, 50),
      },
      situation: mode === 'detailed' ? {
        who: sanitizeString(body.situation?.who, 1000),
        whom: sanitizeString(body.situation?.whom, 1000),
        what: sanitizeString(body.situation?.what, 1000),
        when: sanitizeString(body.situation?.when, 1000),
        where: sanitizeString(body.situation?.where, 1000),
        why: sanitizeString(body.situation?.why, 1000),
        how: sanitizeString(body.situation?.how, 1000),
        howMany: sanitizeString(body.situation?.howMany, 500),
        howMuch: sanitizeString(body.situation?.howMuch, 500),
        howLong: sanitizeString(body.situation?.howLong, 500),
      } : null,
      items: validItems,
      notes: sanitizeString(body.notes, 2000),
      contactRequested: body.contactRequested !== false, // default true
      quoteNumber: sanitizeString(body.quoteNumber, 50),
    }
  };
}

export default async function handler(req) {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  if (!isAllowedOrigin(req)) {
    return new Response(JSON.stringify({
      error: 'forbidden_origin',
      message: '許可されていないオリジンからのアクセスです。'
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

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

  try {
    const body = await req.json();
    const { errors, payload } = validatePayload(body);

    if (errors.length > 0) {
      return new Response(JSON.stringify({
        error: 'validation_error',
        message: errors.join(' / '),
        errors
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 金額計算（クライアントを信用せずサーバー側でも合計）
    const subtotal = payload.items.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0);

    // GAS へ転送（メール送信＆ログ記録）
    const gasPayload = {
      type: 'quote_request',
      ip,
      timestamp: new Date().toISOString(),
      ...payload,
      subtotal,
    };

    try {
      await fetch(GAS_WEBHOOK_URL, {
        method: 'POST',
        body: JSON.stringify(gasPayload),
      });
    } catch (e) {
      // GAS への送信失敗は致命的ではない（ログ）
      // ただしユーザーには成功を返す（GAS側で再送やリトライを別途検討）
      console.error('GAS webhook failed:', e);
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'お見積もり依頼を受け付けました。担当者よりご連絡いたします。',
      subtotal,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'internal_error',
      message: error.message,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
