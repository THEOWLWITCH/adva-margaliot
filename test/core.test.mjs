// בדיקות ללוגיקת השרת, עם מאגר בזיכרון ואחסון קבצים מדומה: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, handleChunk, CHUNK } from '../netlify/functions/lib/core.mjs';

function setup(env = { LECTURER_CODE: 'ADVA-START-01' }) {
  const m = new Map(), removed = [];
  const store = {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async list(p) { return [...m.keys()].filter((k) => k.startsWith(p)).sort().map((k) => ({ key: k, value: structuredClone(m.get(k)) })); },
    async delPrefix(p) { for (const k of [...m.keys()]) if (k.startsWith(p)) m.delete(k); },
  };
  const blobs = new Map();
  const files = {
    async put(k, b) { blobs.set(k, b); },
    async get(k) { return blobs.get(k) || null; },
    async del(k) { blobs.delete(k); removed.push(k); },
  };
  const ctx = { store, files, env, siteUrl: 'https://site' };
  const api = (body) => handle(body, ctx);
  const chunk = (method, ticket, n, bytes) => handleChunk(method, ticket, n, bytes, ctx);
  return { api, m, removed, blobs, chunk };
}

test('הזרימה המלאה: מרצה, קורס, שיעור, חומרים, הגשה והודעה', async () => {
  const { api, m, removed, chunk } = setup();
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
  [st] = await chunk('PUT', r.ticket, 0, new ArrayBuffer(10)); assert.equal(st, 200);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'file', path: mat, name: 'מצגת.pptx', size: 10 } }); assert.equal(r.lessons[0].items.length, 1);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'file', path: `c/${cid2}/mat/abcdefgh.pdf`, name: 'x' } }); assert.equal(st, 400);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: L1, item: { kind: 'link', url: 'javascript:alert(1)' } }); assert.equal(st, 400);
  [st, r] = await api({ action: 'itemSave', cid, token: lec, where: 'syllabus', item: { kind: 'link', url: 'https://example.com/a', title: 'רשימת קריאה' } }); assert.equal(r.syllabus.items.length, 1);
  [st, r] = await api({ action: 'file', cid, token: stu, path: mat }); assert.equal(st, 200); assert.equal(r.parts, 1);
  [st, r] = await chunk('GET', r.ticket, 0); assert.equal(st, 200); assert.equal(r.byteLength, 10);
  [st] = await chunk('GET', 'bad.ticket', 0); assert.equal(st, 403);

  [st, r] = await api({ action: 'upload', cid, token: stu, purpose: 'sub', name: 'עבודה.docx', size: 30 * 1024 * 1024 }); assert.equal(st, 413);
  const big = CHUNK * 2 + 5;
  [st, r] = await api({ action: 'upload', cid, token: stu, purpose: 'sub', name: 'עבודה.docx', size: big }); const sp = r.path; assert.ok(sp.includes('/sub/' + sid + '/'));
  assert.equal(r.parts, 3);
  [st] = await chunk('PUT', r.ticket, 0, new ArrayBuffer(CHUNK)); assert.equal(st, 200);
  [st] = await chunk('PUT', r.ticket, 1, new ArrayBuffer(CHUNK)); assert.equal(st, 200);
  [st] = await chunk('PUT', r.ticket, 2, new ArrayBuffer(6)); assert.equal(st, 400); // גודל לא נכון
  [st] = await chunk('PUT', r.ticket, 2, new ArrayBuffer(5)); assert.equal(st, 200);
  [st] = await chunk('PUT', r.ticket, 3, new ArrayBuffer(5)); assert.equal(st, 403); // אין חלק כזה
  [st, r] = await api({ action: 'get', cid, token: r.ticket }); assert.equal(st, 401); // כרטיס אינו כניסה
  [st, r] = await api({ action: 'submit', cid, token: stu, name: 'נועה', lessonId: L1, files: [{ path: sp, name: 'עבודה.docx', size: big }] }); assert.equal(st, 200);
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

  // לוח ההודעות
  [st, r] = await api({ action: 'postSave', cid, token: stu, post: { text: 'x' } }); assert.equal(st, 403);
  [st, r] = await api({ action: 'postSave', cid, token: lec, post: {} }); assert.equal(st, 400);
  [st, r] = await api({ action: 'upload', cid, token: lec, purpose: 'mat', name: 'תמונה.png', size: 10 }); const img = r.path;
  [st, r] = await api({ action: 'postSave', cid, token: lec, post: { text: 'ברוכים הבאים', link: 'https://example.com', file: { path: img, name: 'תמונה.png', size: 10, type: 'image/png' } } });
  assert.equal(r.posts.length, 1); const pid = r.posts[0].id;
  [st, r] = await api({ action: 'get', cid, token: stu }); assert.equal(r.posts[0].text, 'ברוכים הבאים'); assert.equal(r.posts[0].file.path, img);
  [st, r] = await api({ action: 'file', cid, token: stu, path: img }); assert.equal(st, 200);
  [st, r] = await api({ action: 'postSave', cid, token: lec, post: { id: pid, text: 'עודכן', file: null } }); assert.equal(r.posts[0].text, 'עודכן'); assert.equal(r.posts[0].file, null);
  assert.ok(removed.includes(img + '/0'));
  [st, r] = await api({ action: 'postDelete', cid, token: lec, id: pid }); assert.equal(r.posts.length, 0);
  [st, r] = await api({ action: 'studentCode', cid, token: lec, code: 'adva-2026' }); assert.equal(r.studentCode, 'ADVA-2026');
  [st, r] = await api({ action: 'login', code }); assert.equal(st, 403);
  [st, r] = await api({ action: 'login', code: 'ADVA2026' }); assert.equal(r.cid, cid);
  [st, r] = await api({ action: 'studentCode', cid: cid2, token: lec, code: 'ADVA2026' }); assert.equal(r.error, 'code-taken');

  [st, r] = await api({ action: 'lecturerCode', token: lec, code: 'NEW-LECT-CODE' }); assert.equal(r.lecturer.ownCode, true);
  [st, r] = await api({ action: 'login', code: 'ADVA-START-01' }); assert.equal(st, 403);
  [st, r] = await api({ action: 'login', code: 'newlectcode' }); assert.equal(r.role, 'l');

  [st, r] = await api({ action: 'courseDelete', token: lec, cid }); assert.equal(r.courses.length, 1);
  assert.ok(removed.includes(mat + '/0') && removed.includes(sp + '/2'));
  assert.equal([...m.keys()].filter((k) => k.includes(cid)).length, 0);
  [st, r] = await api({ action: 'login', code: 'ADVA2026' }); assert.equal(st, 403);
});

test('בלי LECTURER_CODE אין כניסת מרצה', async () => {
  const { api } = setup({});
  const [st] = await api({ action: 'login', code: '' });
  assert.equal(st, 403);
});

test('פנקס: רשימת סטודנטים, משימות, הגשת צוות, ציונים והערות', async () => {
  const { api } = setup();
  let [st, r] = await api({ action: 'login', code: 'ADVA-START-01' }); const lec = r.token;
  [st, r] = await api({ action: 'courseCreate', token: lec, title: 'קורס' }); const cid = r.created; const code = r.courses[0].studentCode;
  [st, r] = await api({ action: 'rosterAdd', cid, token: lec, text: 'נועה כהן\nדנה לוי\n\nנועה כהן\nיעל ברק' }); assert.equal(r.roster.length, 3);
  const id = (n) => r.roster.find((x) => x.name === n).id;
  const noa = id('נועה כהן'), dana = id('דנה לוי'), yael = id('יעל ברק');
  [st, r] = await api({ action: 'taskSave', cid, token: lec, task: { title: 'עבודת צוות', due: '2026-11-20', team: true } }); const team = r.tasks[0].id;
  [st, r] = await api({ action: 'taskSave', cid, token: lec, task: { title: 'תרגיל 1', due: '2026-11-01' } }); const ex1 = r.tasks.find((t) => t.title === 'תרגיל 1').id;
  assert.equal(r.tasks[0].id, ex1); // ממוין לפי מועד

  [st, r] = await api({ action: 'login', code }); const stu = r.token;
  [st, r] = await api({ action: 'get', cid, token: stu }); assert.equal(r.roster.length, 3); assert.equal(r.tasks.length, 2);
  [st, r] = await api({ action: 'rosterAdd', cid, token: stu, text: 'x' }); assert.equal(st, 403);
  [st, r] = await api({ action: 'book', cid, token: stu }); assert.equal(st, 403);
  // הגשת צוות: נועה ודנה
  [st, r] = await api({ action: 'submit', cid, token: stu, studentIds: [noa, dana, 'zzz'], taskId: team, link: 'https://drive.example.com/x' });
  assert.deepEqual(r.sub.studentIds, [noa, dana]); assert.equal(r.sub.name, 'נועה כהן, דנה לוי'); assert.equal(r.sub.taskTitle, 'עבודת צוות');
  // משימה אישית: רק הראשונה נספרת
  [st, r] = await api({ action: 'submit', cid, token: stu, studentIds: [yael, noa], taskId: ex1, link: 'https://x.example.com' });
  assert.deepEqual(r.sub.studentIds, [yael]);
  // שם שלא ברשימה
  [st, r] = await api({ action: 'submit', cid, token: stu, name: 'מישהי חדשה', taskId: ex1, link: 'https://y.example.com' }); const loose = r.sub.id;
  assert.deepEqual(r.sub.studentIds, []);
  [st, r] = await api({ action: 'subAssign', cid, token: lec, id: loose, studentIds: [noa], taskId: ex1 }); assert.equal(r.sub.name, 'נועה כהן');

  [st, r] = await api({ action: 'dashboard', token: lec });
  const t = r.courses[0].tasks; assert.equal(t.find((x) => x.id === team).done, 2); assert.equal(t.find((x) => x.id === ex1).done, 2);
  assert.equal(r.courses[0].students, 3);

  [st, r] = await api({ action: 'gradeSet', cid, token: lec, taskId: team, studentId: noa, grade: '95' }); assert.equal(st, 200);
  [st, r] = await api({ action: 'notesSave', cid, token: lec, notes: 'לזכור: לבדוק את ההגשות עד שישי' });
  [st, r] = await api({ action: 'studentNote', cid, token: lec, studentId: dana, note: 'ביקשה הארכה' });
  [st, r] = await api({ action: 'book', cid, token: lec });
  assert.equal(r.grades[team][noa], '95'); assert.equal(r.notes, 'לזכור: לבדוק את ההגשות עד שישי'); assert.equal(r.studentNotes[dana], 'ביקשה הארכה'); assert.equal(r.subs.length, 3);
  [st, r] = await api({ action: 'get', cid, token: stu }); assert.equal(JSON.stringify(r).includes('ביקשה הארכה'), false); assert.equal(JSON.stringify(r).includes('95'), false);
  [st, r] = await api({ action: 'taskDelete', cid, token: lec, id: ex1 }); assert.equal(r.tasks.length, 1);
  [st, r] = await api({ action: 'rosterRemove', cid, token: lec, id: yael }); assert.equal(r.roster.length, 2);
});
