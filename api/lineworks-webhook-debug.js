// 一時的なデバッグ用 webhook エンドポイント
// LINE WORKS からの全イベントをログに出力してChannel IDを確認する
export const config = { runtime: 'nodejs' };

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  const body = await readBody(req);
  console.log('[WEBHOOK-DEBUG] Received event:', JSON.stringify(body));
  return res.status(200).json({ ok: true });
}
