// השמירה של האתר: Netlify Blobs — חלק מהאתר עצמו ב-Netlify, בלי חשבון או שירות חיצוני.
// שני מאגרים: adva-data (נתונים, JSON) ו-adva-files (חלקי הקבצים).
// consistency: 'strong' — מה שנשמר נקרא מיד (בלי השהיה של עד דקה).
import { getStore } from '@netlify/blobs';

export function kvStore() {
  const s = getStore({ name: 'adva-data', consistency: 'strong' });
  const keys = async (prefix) => {
    const out = [];
    for await (const page of s.list({ prefix, paginate: true })) for (const b of page.blobs) out.push(b.key);
    return out.sort();
  };
  return {
    get: (k) => s.get(k, { type: 'json' }),
    set: (k, v) => s.setJSON(k, v),
    del: (k) => s.delete(k),
    async list(prefix) {
      const ks = await keys(prefix);
      const vals = await Promise.all(ks.map((k) => s.get(k, { type: 'json' })));
      return ks.map((key, i) => ({ key, value: vals[i] })).filter((r) => r.value != null);
    },
    async delPrefix(prefix) { for (const k of await keys(prefix)) await s.delete(k); },
  };
}

export function fileStore() {
  const s = getStore({ name: 'adva-files', consistency: 'strong' });
  return {
    put: (k, bytes) => s.set(k, bytes),
    get: (k) => s.get(k, { type: 'arrayBuffer' }),
    del: (k) => s.delete(k),
  };
}
