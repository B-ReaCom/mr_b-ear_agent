// LINE WORKS: Bot 経由でグループチャンネルを新規作成（4名招待）
// 成功すると channelId が返るので、それを LINE_WORKS_CHANNEL_ID に設定する。
//
// 使用例:
//   GET /api/lineworks-create-channel?title=Mr.%20B-EAR%20%E3%83%AA%E3%83%BC%E3%83%89%E9%80%9A%E7%9F%A5

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
  if (!data.access_token) throw new Error('token failed: ' + JSON.stringify(data));
  return data.access_token;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const title = url.searchParams.get('title') || 'Mr. B-EAR リード通知';

    // 4名のスタッフ
    const memberIds = [
      '110002508323920', // 中橋
      '110002508323923', // 大和田
      '110002509044001', // 長岡
      '110002512836586', // 山口
    ];

    const token = await getAccessToken();
    const botId = process.env.LINE_WORKS_BOT_ID;

    // 試す候補エンドポイント
    const base = `https://www.worksapis.com/v1.0/bots/${botId}/channels`;
    const attempts = [
      { url: base, body: { title, members: memberIds } },
      { url: base, body: { title, members: memberIds.map(id => ({ accountId: id })) } },
      { url: base, body: { title, members: memberIds.map(id => ({ userId: id })) } },
      { url: base, body: { title, members: { accountIds: memberIds } } },
      { url: base, body: { title, members: { userIds: memberIds } } },
      { url: base, body: { title, members: { memberIds } } },
    ];

    const results = [];
    for (const a of attempts) {
      const r = await fetch(a.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(a.body),
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      results.push({ url: a.url, body: a.body, status: r.status, response: data });
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).json({ ok: true, success: results[results.length - 1], all: results });
      }
    }

    return res.status(200).json({ ok: false, attempts: results });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
