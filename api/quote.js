// Midland Hearts 自動見積もり API
// 見積もり依頼を受け取り、メール通知を送信する。
// Vercel Edge Function
//
// 送信経路（優先順）:
//   1. RESEND_API_KEY が設定されていれば Resend で送信（新フォーマット）
//   2. 未設定 or Resend 送信失敗時は GAS Webhook にフォールバック（旧フォーマット）
//
// 環境変数 (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY    Resend の API キー (re_xxxxxxxx) — 任意（無ければ GAS にフォールバック）
//   QUOTE_EMAIL_TO    通知先メールアドレス。未指定なら下記デフォルトを使用
//   QUOTE_EMAIL_FROM  送信元メールアドレス。未指定なら下記デフォルトを使用
//   QUOTE_EMAIL_CC    Cc に入れたいアドレス（カンマ区切り可）— 任意

export const config = {
  runtime: 'edge',
};

const DEFAULT_EMAIL_TO   = 'info@midhts.com';
const DEFAULT_EMAIL_FROM = 'onboarding@resend.dev'; // ドメイン検証前のテスト用送信元

// GAS フォールバック用 Webhook（USAGE_LOG/QA_LOG と同居）
const GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbz0Jm2Fc_7pimlmmjGaH2CP_wkQL8MQWsthm0_BBKMOHXIRrdE-lqyTOaDhDT6tRazM/exec';

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

// ===== 通知メールの本文組み立て =====
function buildEmailContent(payload, subtotal, timestamp) {
  const c = payload.customer;
  const courseLabel = payload.mode === 'detailed' ? '詳しく相談' : 'クイック見積もり';
  const quoteNumber = payload.quoteNumber || '(自動採番なし)';
  const grandTotal = Math.floor(subtotal * 1.1);
  const tax = grandTotal - subtotal;
  const recipientName = c.company || c.name || '名前未入力';

  const subject = payload.contactRequested
    ? `【自動見積もり / 要対応】${recipientName}（${quoteNumber}）`
    : `【自動見積もり / 連絡不要】${recipientName}（${quoteNumber}）`;

  const contactBlock = payload.contactRequested
    ? `■ 担当者からの連絡: ★希望あり★  → 折り返しのご連絡をお願いします`
    : `■ 担当者からの連絡: 希望なし    → 記録のみ（対応不要）`;

  const itemsText = payload.items
    .map(it => `${it.name} × ${it.quantity} = ¥${(it.unitPrice * it.quantity).toLocaleString()}`)
    .join('\n');

  const sit = payload.situation;
  const sitText = sit ? [
    sit.who      ? `[Who] ${sit.who}` : null,
    sit.whom     ? `[Whom] ${sit.whom}` : null,
    sit.what     ? `[What] ${sit.what}` : null,
    sit.when     ? `[When] ${sit.when}` : null,
    sit.where    ? `[Where] ${sit.where}` : null,
    sit.why      ? `[Why] ${sit.why}` : null,
    sit.how      ? `[How] ${sit.how}` : null,
    sit.howMany  ? `[How many] ${sit.howMany}` : null,
    sit.howMuch  ? `[How much] ${sit.howMuch}` : null,
    sit.howLong  ? `[How long] ${sit.howLong}` : null,
  ].filter(Boolean).join('\n') : '';

  let body = `ミッドランドハーツ 自動見積もりシステムにて見積書が発行されました。

━━━━━━━━━━━━━━━━━━━━━━━━━━
${contactBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━

見積番号: ${quoteNumber}
コース: ${courseLabel}
発行日時: ${new Date(timestamp).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}

【お客様情報】
お名前: ${c.name || ''}
会社名: ${c.company || '(未入力)'}
部署・役職: ${c.department || '(未入力)'}
メール: ${c.email || ''}
電話: ${c.phone || '(未入力)'}

【ご希望の製品】
${itemsText || '(なし)'}

小計（税抜）: ¥${subtotal.toLocaleString()}
消費税（10%）: ¥${tax.toLocaleString()}
合計（税込）: ¥${grandTotal.toLocaleString()}
`;

  if (sitText) {
    body += `\n【ご利用シーン（6W4H）】\n${sitText}\n`;
  }

  if (payload.notes) {
    body += `\n【備考・ご要望】\n${payload.notes}\n`;
  }

  body += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\nこのメールは自動見積もりシステムより自動送信されています。\n`;

  return { subject, body };
}

// ===== Resend へ送信 =====
async function sendEmailViaResend({ apiKey, from, to, cc, subject, text }) {
  const body = { from, to: [to], subject, text };
  if (cc) body.cc = cc.split(',').map(s => s.trim()).filter(Boolean);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${errText}`);
  }
  return res.json();
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
    const timestamp = new Date().toISOString();

    const apiKey = process.env.RESEND_API_KEY;
    const to     = process.env.QUOTE_EMAIL_TO   || DEFAULT_EMAIL_TO;
    const from   = process.env.QUOTE_EMAIL_FROM || DEFAULT_EMAIL_FROM;
    const cc     = process.env.QUOTE_EMAIL_CC   || '';

    let emailSent = false;

    if (apiKey) {
      const { subject, body: text } = buildEmailContent(payload, subtotal, timestamp);
      try {
        await sendEmailViaResend({ apiKey, from, to, cc, subject, text });
        emailSent = true;
      } catch (e) {
        console.error('Resend send failed, will try GAS fallback:', e?.message || e);
      }
    } else {
      console.log('RESEND_API_KEY not set — using GAS fallback');
    }

    if (!emailSent) {
      const gasPayload = {
        type: 'quote_request',
        ip,
        timestamp,
        ...payload,
        subtotal,
      };
      try {
        await fetch(GAS_WEBHOOK_URL, {
          method: 'POST',
          body: JSON.stringify(gasPayload),
        });
      } catch (e) {
        console.error('GAS webhook fallback also failed:', e?.message || e);
      }
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
