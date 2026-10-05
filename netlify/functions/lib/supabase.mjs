// חיבור ל-Supabase של הפרויקט הזה בלבד: טבלת kv לנתונים, ודלי פרטי course-files לקבצים.
// משתמשים במפתח service_role — הוא נשאר בשרת (משתני הסביבה ב-Netlify) ולא מגיע לדפדפן.

export function kvStore(url, key) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1/kv`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const ok = async (r) => { if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); return r; };
  // like של PostgREST: * הוא התו הכללי. מפתחות אצלנו בלי % ו-_ (מזהים מאותיות וספרות).
  const like = (p) => encodeURIComponent(p + '*');
  return {
    async get(k) {
      const rows = await (await ok(await fetch(`${base}?key=eq.${encodeURIComponent(k)}&select=value`, { headers }))).json();
      return rows.length ? rows[0].value : null;
    },
    async set(k, value) {
      await ok(await fetch(base, { method: 'POST', headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: k, value, updated_at: new Date().toISOString() }) }));
    },
    async del(k) { await ok(await fetch(`${base}?key=eq.${encodeURIComponent(k)}`, { method: 'DELETE', headers })); },
    async list(prefix) {
      return (await ok(await fetch(`${base}?key=like.${like(prefix)}&select=key,value&order=key&limit=10000`, { headers }))).json();
    },
    async delPrefix(prefix) { await ok(await fetch(`${base}?key=like.${like(prefix)}`, { method: 'DELETE', headers })); },
  };
}

export function fileStore(url, key, bucket = 'course-files') {
  const base = url.replace(/\/+$/, '') + '/storage/v1';
  const json = { apikey: key, Authorization: 'Bearer ' + key, 'content-type': 'application/json' };
  const fail = async (r, what) => { throw new Error(`Storage ${what} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); };
  let ready = null;
  // הדלי נוצר בפעם הראשונה (פרטי). אם כבר קיים — ממשיכים.
  const ensure = () => (ready ||= (async () => {
    const r = await fetch(base + '/bucket', { method: 'POST', headers: json, body: JSON.stringify({ id: bucket, name: bucket, public: false }) });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if (r.status !== 409 && !/exist|duplicate/i.test(t)) { ready = null; throw new Error(`Storage bucket ${r.status}: ${t.slice(0, 200)}`); }
    }
  })());
  return {
    async uploadUrl(path) {
      await ensure();
      const r = await fetch(`${base}/object/upload/sign/${bucket}/${path}`, { method: 'POST', headers: json, body: '{}' });
      if (!r.ok) await fail(r, 'upload-sign');
      return base + (await r.json()).url;
    },
    async signedUrl(path, seconds, downloadName) {
      const r = await fetch(`${base}/object/sign/${bucket}/${path}`, { method: 'POST', headers: json, body: JSON.stringify({ expiresIn: seconds }) });
      if (!r.ok) await fail(r, 'sign');
      const j = await r.json();
      const u = base + (j.signedURL || j.signedUrl);
      return downloadName ? u + (u.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(downloadName) : u;
    },
    async remove(paths) {
      if (!paths.length) return;
      const r = await fetch(`${base}/object/${bucket}`, { method: 'DELETE', headers: json, body: JSON.stringify({ prefixes: paths }) });
      if (!r.ok) await fail(r, 'remove');
    },
  };
}
