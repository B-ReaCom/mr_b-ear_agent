// 任意の userId に対して DM を送れるかテストするデバッグ用エンドポイント
// 使用例:
//   GET /api/lineworks-test-dm?userId=110002508323923&text=テスト

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
  const r = await fetch(LINE_WORKS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json();
  return data.access_token;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    const text = url.searchParams.get('text') || 'test from /api/lineworks-test-dm';
    if (!userId) return res.status(400).json({ error: 'missing userId' });

    const token = await getAccessToken();
    const botId = process.env.LINE_WORKS_BOT_ID;
    const apiUrl = `https://www.worksapis.com/v1.0/bots/${botId}/users/${userId}/messages`;
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { type: 'text', text } }),
    });
    const body = await r.text();
    return res.status(200).json({ status: r.status, body, apiUrl });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
