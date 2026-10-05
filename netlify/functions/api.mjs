// POST /api — כל הפעולות של האתר (netlify/functions/lib/core.mjs).
import { handle } from './lib/core.mjs';
import { kvStore, fileStore } from './lib/supabase.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const env = process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return json(503, { error: 'storage unavailable' });
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid JSON' }); }
  try {
    const [status, out] = await handle(body, {
      store: kvStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY),
      files: fileStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY),
      env,
      siteUrl: (env.SITE_URL || env.URL || new URL(req.url).origin).replace(/\/$/, ''),
    });
    return json(status, out);
  } catch (e) {
    console.error('api: ' + e.message);
    return json(503, { error: 'storage unavailable' });
  }
};

export const config = { path: '/api' };
