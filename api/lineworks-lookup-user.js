// Mr. B-EAR - LINE WORKS ユーザーをemailで検索してUserIDを返す
// 用途: 通知先のUser IDを取得して LINE_WORKS_NOTIFY_USER_ID に設定するため
//
// アクセス方法:
//   https://mr-b-ear-agent.vercel.app/api/lineworks-lookup-user?email=bear@bearidge55
//   https://mr-b-ear-agent.vercel.app/api/lineworks-lookup-user?emails=bear@bearidge55,kisachi@bearidge55,rie@bearidge55,haruna@bearidge55

export const config = { runtime: 'nodejs' };

import crypto from 'crypto';

const LINE_WORKS_TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';

async function getAccessToken(scope = 'directory.read user.read bot bot.message') {
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
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(privateKey, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const params = new URLSearchParams({
    assertion: jwt,
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: process.env.LINE_WORKS_CLIENT_ID,
    client_secret: process.env.LINE_WORKS_CLIENT_SECRET,
    scope,
  });

  const response = await fetch(LINE_WORKS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error(`token failed ${response.status}: ${t}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function lookupByEmail(token, email) {
  // 複数のエンドポイント形式を試す
  const endpoints = [
    `https://www.worksapis.com/v1.0/users?email=${encodeURIComponent(email)}`,
    `https://www.worksapis.com/v1.0/users/${encodeURIComponent(email)}`,
  ];
  const out = {};
  for (const url of endpoints) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    out[url] = { status: r.status, data };
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const single = url.searchParams.get('email');
    const multi = url.searchParams.get('emails');
    const emails = multi
      ? multi.split(',').map(s => s.trim()).filter(Boolean)
      : (single ? [single] : []);

    if (emails.length === 0) {
      return res.status(400).json({
        error: 'missing email',
        usage: '?email=user@domain  または  ?emails=a@d,b@d,c@d',
      });
    }

    // scope を順番に試す（権限がない場合に備えて）
    let token;
    const scopes = [
      'directory.read',
      'user.read',
      'directory.read user.read',
      'bot bot.message directory.read',
    ];
    let lastErr;
    for (const s of scopes) {
      try {
        token = await getAccessToken(s);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!token) throw lastErr || new Error('no scope worked');

    const results = {};
    for (const e of emails) {
      results[e] = await lookupByEmail(token, e);
    }
    return res.status(200).json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
