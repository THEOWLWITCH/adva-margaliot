// בדיקות ללוגיקת השרת, עם מאגר בזיכרון ואחסון קבצים מדומה: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../netlify/functions/lib/core.mjs';

function setup(env = { LECTURER_CODE: 'ADVA-START-01' }) {
  const m = new Map(), removed = [];
  const store = {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async list(p) { return [...m.keys()].filter((k) => k.startsWith(p)).sort().map((k) => ({ key: k, value: structuredClone(m.get(k)) })); },
    async delPrefix(p) { for (const k of [...m.keys()]) if (k.startsWith(p)) m.delete(k); },
  };
  const files = {
    async uploadUrl(p) { return 'https://up/' + p; },
    async signedUrl(p, s, d) { return 'https://dl/' + p + (d ? '?download=' + d : ''); },
    async remove(ps) { removed.push(...ps); },
  };
  const api = (body) => handle(body, { store, files, env, siteUrl: 'https://site' });
  return { api, m, removed };
}

test('הזרימה המלאה: מרצה, קורס, שיעור, חומרים, הגשה והודעה', async () => {
  const { api, m, removed } = setup();
  let [st, r] = await api({ action: 'login', code: 'wrong' }); assert.equal(st, 403);
  [st, r] = await api({ action: 'login', code: 'adva-start-01' }); assert.equal(r.role, 'l'); const lec = r.token;
  [st, r] = await api({ action: 'dashboard', token: lec }); assert.equal(r.courses.length, 0); assert.equal(r.lecturer.email, 'adva_m@achva.ac.il');
  [st, r] = await api({ action: 'courseCreate', token: lec, title: 'קורס א' }); const cid = r.created; assert.ok(cid);
  const code = r.courses[0].studentCode;
  [st, r] = await api({ action: 'courseCreate', token: lec, title: 'קורס ב' }); const cid2 = r.created;

  [st, r] = await api({ action: 'login', code: code.toLowerCase() }); assert.equal(r.role, 's'); assert.equal(r.cid, cid);
  const stu = r.token, sid = r.sid;
  [st, r] = await api({ action: 'get', cid, token: stu }); assert.equal(st, 200); assert.equal(r.studentCode, undefined);
  [st, r] = await api({ action: 'get', cid: cid2, token: stu }); assert.equal(st, 403); // קורס אחר
  [st, r] = await api({ action: 'dashboard', token: stu }); assert.equal(st, 403);
  [st, r] = await api({ action: 'save', cid, token: stu, patch: { title: 'x' } }); assert.equal(st, 403);

  [st, r] = await api({ action: 'lessonSave', cid, token: lec, lesson: { title: 'מבוא', date: '2026-10-27', task: true } }); const L1 = r.saved;
  [st, r] = await api({ action: 'upload', cid, token: stu, purpose: 'mat', name: 'a.pdf', size: 10 }); assert.equal(st, 403);
  [st, r] = await api({ action: 'upload', cid, token: lec, purpose: 'mat', name: 'מצגת.PPTX', size: 10 }); assert.match(r.path, /^c\/\w+\/mat\/\w+\.pptx$/);
  const mat = r.path;
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'file', path: mat, name: 'מצגת.pptx', size: 10 } }); assert.equal(r.lessons[0].items.length, 1);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'file', path: `c/${cid2}/mat/abcdefgh.pdf`, name: 'x' } }); assert.equal(st, 400);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'link', url: 'javascript:alert(1)' } }); assert.equal(st, 400);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: 'syllabus', item: { kind: 'link', url: 'https://example.com/a', title: 'רשימת קריאה' } }); assert.equal(r.syllabus.items.length, 1);
  [st, r] = await api({ action: 'file', cid, token: stu, path: mat }); assert.equal(st, 200);

  [st, r] = await api({ action: 'upload', cid, token: stu, purpose: 'sub', name: 'עבודה.docx', size: 30 * 1024 * 1024 }); assert.equal(st, 413);
  [st, r] = await api({ action: 'upload', cid, token: stu, purpose: 'sub', name: 'עבודה.docx', size: 100 }); const sp = r.path; assert.ok(sp.includes('/sub/' + sid + '/'));
  [st, r] = await api({ action: 'submit', cid, token: stu, name: 'נועה', lessonId: L1, files: [{ path: sp, name: 'עבודה.docx', size: 100 }] }); assert.equal(st, 200);
  [st, r] = await api({ action: 'submit', cid, token: stu, name: 'נועה', files: [{ path: `c/${cid}/sub/ffffffffffffffff/x.pdf` }] }); assert.equal(st, 400);
  [st, r] = await api({ action: 'subs', cid, token: stu }); assert.equal(st, 403);
  [st, r] = await api({ action: 'mySubs', cid, token: stu }); assert.equal(r.subs.length, 1);
  [st, r] = await api({ action: 'subs', cid, token: lec }); assert.equal(r.subs[0].lessonTitle, 'מבוא');
  [st, r] = await api({ action: 'login', code }); const stu2 = r.token;
  [st, r] = await api({ action: 'file', cid, token: stu2, path: sp }); assert.equal(st, 403); // הגשה של מישהו אחר
  [st, r] = await api({ action: 'file', cid, token: lec, path: sp }); assert.equal(st, 200);

  [st, r] = await api({ action: 'message', cid, token: stu, name: 'נועה', text: 'שאלה', email: 'n@x.co' }); assert.equal(r.ok, true); assert.equal(r.mailed, false);
  [st, r] = await api({ action: 'messages', cid, token: stu }); assert.equal(st, 403);
  [st, r] = await api({ action: 'dashboard', token: lec }); assert.equal(r.courses.find((c) => c.id === cid).newMsgs, 1);

  [st, r] = await api({ action: 'studentCode', cid, token: lec, code: 'adva-2026' }); assert.equal(r.studentCode, 'ADVA-2026');
  [st, r] = await api({ action: 'login', code }); assert.equal(st, 403);
  [st, r] = await api({ action: 'login', code: 'ADVA2026' }); assert.equal(r.cid, cid);
  [st, r] = await api({ action: 'studentCode', cid: cid2, token: lec, code: 'ADVA2026' }); assert.equal(r.error, 'code-taken');

  [st, r] = await api({ action: 'lecturerCode', token: lec, code: 'NEW-LECT-CODE' }); assert.equal(r.lecturer.ownCode, true);
  [st, r] = await api({ action: 'login', code: 'ADVA-START-01' }); assert.equal(st, 403);
  [st, r] = await api({ action: 'login', code: 'newlectcode' }); assert.equal(r.role, 'l');

  [st, r] = await api({ action: 'courseDelete', token: lec, cid }); assert.equal(r.courses.length, 1);
  assert.ok(removed.includes(mat) && removed.includes(sp));
  assert.equal([...m.keys()].filter((k) => k.includes(cid)).length, 0);
  [st, r] = await api({ action: 'login', code: 'ADVA2026' }); assert.equal(st, 403);
});

test('בלי LECTURER_CODE אין כניסת מרצה', async () => {
  const { api } = setup({});
  const [st] = await api({ action: 'login', code: '' });
  assert.equal(st, 403);
});
