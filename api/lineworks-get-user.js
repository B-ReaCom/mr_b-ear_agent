// アカウントID（数字）から userId（UUID）を取得する
// 使用例:
//   GET /api/lineworks-get-user?accountId=110002508323923

export const config = { runtime: 'nodejs' };

import crypto from 'crypto';

const LINE_WORKS_TOKEN_URL = 'https://auth.worksmobile.com/oauth2/v2.0/token';

async function getAccessToken(scope) {
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
  const r = await fetch(LINE_WORKS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error('token failed for scope ' + scope + ': ' + JSON.stringify(data));
  return data.access_token;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const accountId = url.searchParams.get('accountId') || '110002508323923';

    const botId = process.env.LINE_WORKS_BOT_ID;

    // 複数のscopeを試す
    const scopes = [
      'bot bot.message',
      'bot',
      'user.read',
      'user.profile.read',
      'directory.read',
    ];

    const allResults = {};

    for (const scope of scopes) {
      try {
        const token = await getAccessToken(scope);
        // 複数エンドポイントを試す
        const endpoints = [
          `https://www.worksapis.com/v1.0/users/${accountId}`,
          `https://www.worksapis.com/v1.0/users/${accountId}?fields=userId`,
          `https://www.worksapis.com/v1.0/bots/${botId}/users/${accountId}`,
          `https://www.worksapis.com/v1.0/users?accountId=${accountId}`,
        ];
        const scopeResults = {};
        for (const ep of endpoints) {
          const r = await fetch(ep, { headers: { Authorization: `Bearer ${token}` } });
          const text = await r.text();
          let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
          scopeResults[ep] = { status: r.status, data };
        }
        allResults[scope] = { ok: true, results: scopeResults };
      } catch (e) {
        allResults[scope] = { ok: false, error: e.message || String(e) };
      }
    }

    return res.status(200).json({ accountId, results: allResults });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
