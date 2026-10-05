// POST /api — כל הפעולות של האתר (lib/core.mjs).
// PUT/GET /api/chunk?n=<חלק> + כותרת x-ticket — העלאה והורדה של חלקי קבצים.
import { handle, handleChunk, CHUNK } from './lib/core.mjs';
import { kvStore, fileStore } from './lib/blobs.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req) => {
  const env = process.env;
  const url = new URL(req.url);
  const ctx = { store: kvStore(), files: fileStore(), env, siteUrl: (env.SITE_URL || env.URL || url.origin).replace(/\/$/, '') };
  try {
    if (url.pathname.endsWith('/chunk')) {
      const bytes = req.method === 'PUT' ? await req.arrayBuffer() : null;
      if (bytes && bytes.byteLength > CHUNK) return json(413, { error: 'size' });
      const [status, out] = await handleChunk(req.method, req.headers.get('x-ticket') || url.searchParams.get('t'), url.searchParams.get('n'), bytes, ctx);
      if (out instanceof ArrayBuffer) return new Response(out, { status, headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=600' } });
      return json(status, out);
    }
    // GET /api?action=status — בדיקת הקמה בלבד (האם יש קוד מרצה ומה אורכו, בלי לחשוף אותו)
    if (req.method === 'GET' && url.searchParams.get('action') === 'status') { const [st, out] = await handle({ action: 'status' }, ctx); return json(st, out); }
    if (req.method !== 'POST') return json(405, { error: 'POST only' });
    let body;
    try { body = await req.json(); } catch { return json(400, { error: 'invalid JSON' }); }
    const [status, out] = await handle(body, ctx);
    return json(status, out);
  } catch (e) {
    console.error('api: ' + e.message);
    return json(503, { error: 'storage unavailable' });
  }
};

export const config = { path: ['/api', '/api/chunk'] };
