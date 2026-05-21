// Mr. B-EAR - LINE WORKS Bot Webhook ハンドラー
// グループからメッセージを受信してチャンネルIDをログに記録する

export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);

  // GET: 検証リクエスト
  if (req.method === 'GET') {
    const challenge = url.searchParams.get('challenge') || url.searchParams.get('hub.challenge') || '';
    console.log('[webhook] GET verification, challenge =', challenge);
    if (challenge) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  let body = {};
  try { body = await req.json(); } catch {}

  console.log('[webhook] full body =', JSON.stringify(body));

  // challenge レスポンス（POST 検証）
  if (body.challenge) {
    console.log('[webhook] POST challenge =', body.challenge);
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const channelId = body.source?.channelId || body.channelId || 'unknown';
  const userId = body.source?.userId || body.userId || 'unknown';
  const type = body.type || 'unknown';
  const content = body.content?.text || body.text || '';

  console.log('[webhook] CHANNEL_ID =', channelId);
  console.log('[webhook] type =', type, 'userId =', userId, 'content =', content.substring(0, 100));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
