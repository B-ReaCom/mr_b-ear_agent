// Mr. B-EAR - LINE WORKS Bot Webhook ハンドラー
// グループからメッセージを受信してチャンネルIDをログに記録する

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  let body = {};
  try { body = await req.json(); } catch {}

  const channelId = body.source?.channelId || body.channelId || 'unknown';
  const userId = body.source?.userId || body.userId || 'unknown';
  const type = body.type || 'unknown';
  const content = body.content?.text || body.text || '';

  console.log('[webhook] CHANNEL_ID =', channelId);
  console.log('[webhook] type =', type, 'userId =', userId, 'content =', content.substring(0, 100));
  console.log('[webhook] full body =', JSON.stringify(body));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
