// Mr. B-EAR - LINE WORKS Bot Webhook ハンドラー
// グループからメッセージを受信してチャンネルIDをログに記録する

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // ボディ読み込み
  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      body = await new Promise((resolve) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
      });
    } catch { body = {}; }
  }

  // チャンネルID・送信者・メッセージをログに出力
  const channelId = body.source?.channelId || body.channelId || 'unknown';
  const userId = body.source?.userId || body.userId || 'unknown';
  const type = body.type || 'unknown';
  const content = body.content?.text || body.text || '';

  console.log('[webhook] Event received:', JSON.stringify({ type, channelId, userId, content: content.substring(0, 100) }));
  console.log('[webhook] CHANNEL_ID =', channelId);
  console.log('[webhook] Full body:', JSON.stringify(body));

  return res.status(200).json({ ok: true });
}
