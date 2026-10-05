// סביבת הקורסים של ד״ר אדוה מרגליות — הלוגיקה בשרת.
// המרצה נכנסת בקוד מרצה לאזור הניהול: מוסיפה קורסים, ובכל קורס סילבוס, שיעורים עם חומרים,
// תיבת הגשות שרק היא רואה, והודעות מהסטודנטים (נשמרות באתר ונשלחות גם למייל).
// סטודנטים נכנסים בקוד הקורס.
//
// store: { get(k), set(k, v), del(k), list(prefix) → [{key, value}], delPrefix(prefix) }
//   lecturer          → { name, email, salt, hash }   (קוד המרצה נשמר כ-hash)
//   secret            → { secret }                    (מפתח לחתימת אסימוני כניסה)
//   course:<cid>      → { id, title, about, syllabus:{text, items}, lessons:[...], code, createdAt, updatedAt }
//   code:<CODE>       → { cid }                       (קוד סטודנטים; CODE מנורמל)
//   sub:<cid>:<id>    → הגשה    { id, sid, name, lessonId, lessonTitle, title, note, link, files, at, seen }
//   book:<cid>        → הפנקס של המרצה: { grades:{<task>:{<student>:ציון}}, notes, studentNotes:{<student>:הערה} }
//                       (נפרד מהקורס — הסטודנטים לא רואים אותו)
//   msg:<cid>:<id>    → הודעה   { id, sid, name, email, text, link, file, at, seen, mailed }
//   fm:<path>         → { size, type, parts }          (פרטי קובץ שהועלה)
// files: { put(key, bytes), get(key) → ArrayBuffer|null, del(key) } — הקבצים נשמרים בחלקים
//   של עד 3MB (<path>/<n>), כי בקשה לפונקציה מוגבלת ל-6MB. הדפדפן מעלה ומוריד חלק אחר חלק
//   (/api/chunk) עם כרטיס חתום וקצר מועד.
//   c/<cid>/mat/<rand>.<ext>          חומרי שיעור וסילבוס (כל מי שבקורס)
//   c/<cid>/sub/<sid>/<rand>.<ext>    הגשות (המרצה, והסטודנט/ית שהגיש/ה)
//   c/<cid>/msg/<sid>/<rand>.<ext>    קבצים בהודעות (המרצה, והשולח/ת)
import { randomBytes, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

export const DEFAULTS = { name: 'ד״ר אדוה מרגליות', email: 'adva_m@achva.ac.il' };
const TOKEN_DAYS = 30;
export const CHUNK = 3 * 1024 * 1024;
const MB = 1024 * 1024;
const LIMITS = { mat: 50 * MB, sub: 25 * MB, msg: 15 * MB };
const MAX_COURSES = 60, MAX_LESSONS = 60, MAX_ITEMS = 80, MAX_SUB_FILES = 5;

const ID_ABC = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randId = (n) => { let s = ''; for (const b of randomBytes(n)) s += ID_ABC[b % ID_ABC.length]; return s; };
const newCode = () => { let s = ''; for (const b of randomBytes(8)) s += CODE_ABC[b % CODE_ABC.length]; return s.slice(0, 4) + '-' + s.slice(4); };
// קוד שהוקלד במקלדת עברית ("שגכ..." במקום "ASD...") — ממירים לפי מיקום המקש, גם בשרת (למשל בערך של LECTURER_CODE)
const HE_KEYS = { '/': 'Q', "'": 'W', 'ק': 'E', 'ר': 'R', 'א': 'T', 'ט': 'Y', 'ו': 'U', 'ן': 'I', 'ם': 'O', 'פ': 'P', 'ש': 'A', 'ד': 'S', 'ג': 'D', 'כ': 'F', 'ע': 'G', 'י': 'H', 'ח': 'J', 'ל': 'K', 'ך': 'L', 'ז': 'Z', 'ס': 'X', 'ב': 'C', 'ה': 'V', 'נ': 'B', 'מ': 'N', 'צ': 'M' };
export const normCode = (c) => String(c || '').replace(/[\/'א-ת]/g, (ch) => HE_KEYS[ch] || ch).toUpperCase().replace(/[^A-Z0-9]/g, '');
const validId = (id) => typeof id === 'string' && /^[a-z0-9]{6,20}$/.test(id);
const validSid = (s) => typeof s === 'string' && /^[a-f0-9]{16}$/.test(s);
const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,24}$/i;
const txt = (x, n) => String(x == null ? '' : x).replace(/\r\n?/g, '\n').trim().slice(0, n);
const line = (x, n) => txt(x, n).replace(/\s+/g, ' ');
const safeUrl = (u) => { const s = line(u, 2000); return /^https?:\/\/\S+$/i.test(s) ? s : ''; };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const pause = () => new Promise((r) => setTimeout(r, 400));
const safePath = (p) => /^c\/[a-z0-9]+\/(mat|sub|msg)\/(?:[a-z0-9]+\/)?[a-z0-9]+\.[a-z0-9]+$/.test(p);

// ── אסימון כניסה חתום (HMAC) ──
async function secret(store) {
  let rec = await store.get('secret');
  if (!rec) { rec = { secret: randomBytes(32).toString('hex') }; await store.set('secret', rec); }
  return rec.secret;
}
async function sign(store, payload) {
  const ttl = payload.k ? 3600e3 : TOKEN_DAYS * 864e5; // כרטיס להעלאה/הורדה — שעה; כניסה — 30 יום
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttl })).toString('base64url');
  return body + '.' + createHmac('sha256', await secret(store)).update(body).digest('base64url');
}
export async function verify(store, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!same(sig, createHmac('sha256', await secret(store)).update(body).digest('base64url'))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch { return null; }
}

// ── המרצה ──
const hashCode = (code, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(normCode(code), salt, 32).toString('hex') });
async function lecturer(store, env) {
  const rec = (await store.get('lecturer')) || {};
  return { name: rec.name || env.LECTURER_NAME || DEFAULTS.name, email: rec.email ?? (env.LECTURER_EMAIL || DEFAULTS.email), salt: rec.salt, hash: rec.hash };
}
// עד שהמרצה קובעת קוד משלה — הקוד ממשתנה הסביבה LECTURER_CODE.
async function isLecturerCode(store, env, code) {
  const c = normCode(code);
  if (!c) return false;
  const l = await lecturer(store, env);
  if (l.hash) return same(hashCode(c, l.salt).hash, l.hash);
  return !!env.LECTURER_CODE && normCode(env.LECTURER_CODE).length >= 6 && same(c, normCode(env.LECTURER_CODE));
}

async function codeFree(store, env, c) {
  return !(await store.get('code:' + c)) && !(await isLecturerCode(store, env, c));
}
async function issueStudentCode(store, env, cid, wanted) {
  let c;
  if (wanted) {
    c = normCode(wanted);
    if (c.length < 6 || c.length > 16 || /^\d+$/.test(c)) return { error: 'code-format' };
    if (!(await codeFree(store, env, c))) return { error: 'code-taken' };
    wanted = String(wanted).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  } else {
    do { wanted = newCode(); c = normCode(wanted); } while (!(await codeFree(store, env, c)));
  }
  await store.set('code:' + c, { cid });
  return { code: wanted };
}

// ── מייל למרצה (Resend). בלי RESEND_API_KEY / MAIL_FROM — ההודעה נשמרת באתר בלבד. ──
async function mailLecturer(env, lec, course, msg, fileData, siteUrl) {
  if (!lec.email || !EMAIL_RE.test(lec.email) || !env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  const when = new Date(msg.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
  const site = siteUrl + '/?c=' + course.id + '#inbox';
  const ttl = course.title || 'הקורס';
  const rows = [['שם', msg.name], ['תאריך', when], ...(msg.email ? [['מייל לתשובה', msg.email]] : [])];
  const text = [`הודעה חדשה בקורס "${ttl}"`, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', msg.text,
    msg.link ? '\nקישור: ' + msg.link : '', msg.file ? `\nקובץ מצורף: ${msg.file.name}${fileData ? '' : ' (לצפייה באתר)'}` : '',
    '\nכל ההודעות באתר: ' + site].join('\n');
  const btn = (href, label, bg) => `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;padding:9px 18px;border-radius:999px;font-weight:700;margin:4px 0 4px 8px">${esc(label)}</a>`;
  const html = `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.7;color:#13372A;max-width:580px">
<p style="font-size:13px;color:#4A6359;margin:0">${esc(ttl)}</p>
<h2 style="font-weight:400;color:#1E7B3A;margin:4px 0 14px">הודעה חדשה מ${esc(msg.name)}</h2>
<table style="font-size:14px;color:#4A6359;margin-bottom:12px">${rows.map(([k, v]) => `<tr><td style="padding:2px 0 2px 14px">${esc(k)}</td><td style="color:#13372A">${esc(v)}</td></tr>`).join('')}</table>
<div style="background:#EEF7F3;border-radius:12px;padding:14px 16px;white-space:pre-wrap">${esc(msg.text)}</div>
<p>${msg.link ? btn(msg.link, 'לקישור ששלחו', '#1F5F99') : ''}${msg.file ? '<br><span style="font-size:14px;color:#4A6359">📎 ' + esc(msg.file.name) + (fileData ? ' — מצורף למייל' : ' — לצפייה באתר') + '</span><br>' : ''}${btn(site, 'לכל ההודעות באתר', '#1E7B3A')}</p>
${msg.email ? '<p style="font-size:13px;color:#4A6359">אפשר להשיב ישירות למייל הזה — התשובה תגיע ל' + esc(msg.email) + '.</p>' : ''}
</div>`;
  const body = { from: env.MAIL_FROM, to: [lec.email], subject: `${ttl} — הודעה מ${msg.name}`, text, html };
  if (msg.email) body.reply_to = msg.email;
  if (msg.file && fileData) body.attachments = [{ filename: msg.file.name, content: Buffer.from(fileData).toString('base64') }];
  const send = () => fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await send();
    if (!r.ok && body.attachments) { delete body.attachments; r = await send(); } // בלי צירוף — הקובץ נשאר באתר
    return r.ok;
  } catch { return false; }
}

// ── תצוגות ──
const fileOf = (f) => (f && typeof f === 'object' ? { path: String(f.path || ''), name: line(f.name, 160) || 'קובץ', size: Math.max(0, Number(f.size) || 0), type: line(f.type, 120) } : null);
function cleanItem(x, cid) {
  const kind = x && x.kind === 'file' ? 'file' : 'link';
  const it = { id: validId(x && x.id) ? x.id : randId(10), kind, title: line(x && x.title, 200), note: txt(x && x.note, 600), at: new Date().toISOString() };
  if (kind === 'link') { it.url = safeUrl(x.url); if (!it.url) return null; if (!it.title) it.title = it.url.replace(/^https?:\/\//, '').slice(0, 80); }
  else {
    const f = fileOf(x);
    if (!f || !f.path.startsWith(`c/${cid}/mat/`) || !safePath(f.path)) return null;
    Object.assign(it, f);
    if (!it.title) it.title = f.name;
  }
  return it;
}
const lessonView = (l) => ({ id: l.id, title: l.title, date: l.date || '', about: l.about || '', items: l.items || [], task: !!l.task });
function courseView(c, lec, role) {
  const v = { id: c.id, title: c.title || '', about: c.about || '', lecturer: lec.name, syllabus: { text: c.syllabus?.text || '', items: c.syllabus?.items || [] },
    lessons: (c.lessons || []).map(lessonView), posts: c.posts || [], role, updatedAt: c.updatedAt,
    roster: (c.roster || []).map((x) => ({ id: x.id, name: x.name })), tasks: c.tasks || [] };
  if (role === 'l') { v.studentCode = c.code || ''; v.email = lec.email || ''; }
  return v;
}
async function allFor(store, prefix) {
  return (await store.list(prefix)).map((r) => r.value).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}
const allCourses = async (store) => (await store.list('course:')).map((r) => r.value).filter((c) => c && c.id);
async function courseCard(store, c) {
  const subs = await allFor(store, `sub:${c.id}:`), msgs = await allFor(store, `msg:${c.id}:`);
  return { id: c.id, title: c.title || '', about: c.about || '', studentCode: c.code || '', lessons: (c.lessons || []).length,
    items: (c.lessons || []).reduce((n, l) => n + (l.items || []).length, 0) + (c.syllabus?.items || []).length,
    subs: subs.length, newSubs: subs.filter((x) => !x.seen).length, msgs: msgs.length, newMsgs: msgs.filter((x) => !x.seen).length,
    students: (c.roster || []).length,
    tasks: (c.tasks || []).map((t) => ({ id: t.id, title: t.title, due: t.due || '', team: !!t.team,
      done: new Set(subs.filter((x) => x.taskId === t.id).flatMap((x) => x.studentIds || [])).size,
      subs: subs.filter((x) => x.taskId === t.id).length })),
    createdAt: c.createdAt, updatedAt: c.updatedAt };
}

// ── הטיפול בבקשה. מחזיר [status, body]. ──
// ctx: { store, files, env, siteUrl }
export async function handle(body, ctx) {
  const { store, env = {} } = ctx;
  const getFiles = () => { if (!ctx.files) throw new Error('no storage'); return ctx.files; };
  const tryRemove = async (paths) => {
    for (const p of paths) {
      try {
        const m = await store.get('fm:' + p);
        for (let n = 0; n < (m ? m.parts : 1); n++) await getFiles().del(p + '/' + n);
        await store.del('fm:' + p);
      } catch (e) { console.error('files: ' + e.message); }
    }
  };
  const action = body && body.action;

  if (action === 'login') {
    const c = normCode(body.code);
    const sid = validSid(body.sid) ? body.sid : randomBytes(8).toString('hex');
    if (await isLecturerCode(store, env, c)) {
      const lec = await lecturer(store, env);
      return [200, { ok: true, role: 'l', token: await sign(store, { r: 'l', s: sid }), sid, name: lec.name }];
    }
    const rec = c ? await store.get('code:' + c) : null;
    const course = rec ? await store.get('course:' + rec.cid) : null;
    if (!course) {
      await pause();
      // עדיין אין קוד מרצה בכלל (לא נקבע באתר ולא ב-LECTURER_CODE) — אומרים את זה, כדי שיהיה ברור מה חסר
      const l = await lecturer(store, env);
      const setup = !l.hash && !(env.LECTURER_CODE && normCode(env.LECTURER_CODE).length >= 6);
      return [403, { error: 'wrong', ...(setup ? { setup: true } : {}) }];
    }
    return [200, { ok: true, role: 's', cid: course.id, token: await sign(store, { r: 's', cid: course.id, s: sid }), sid, title: course.title || '' }];
  }

  const lec = await lecturer(store, env);
  if (action === 'status') { // בדיקת הקמה: האם יש קוד מרצה ומה אורכו — בלי לחשוף את הקוד
    const raw = env.LECTURER_CODE || '';
    return [200, { lecturerCodeSet: !!raw, lecturerCodeLength: normCode(raw).length, ownCode: !!lec.hash, mailReady: !!(env.RESEND_API_KEY && env.MAIL_FROM) }];
  }
  if (action === 'public') { // שם הקורס והמרצה — לדף הכניסה (לא סוד)
    const c = validId(body.cid) ? await store.get('course:' + body.cid) : null;
    return [200, { lecturer: lec.name, title: c ? c.title || '' : '', found: !!c }];
  }

  const t = await verify(store, body.token);
  if (!t || t.k) { await pause(); return [401, { error: 'login' }]; }
  const L = t.r === 'l';
  const deny = async () => { await pause(); return [403, { error: 'unauthorized' }]; };

  // ── אזור הניהול של המרצה ──
  const removeCourse = async (c) => {
    const paths = [];
    const take = (it) => { if (it && it.path) paths.push(it.path); };
    (c.syllabus?.items || []).forEach(take);
    (c.posts || []).forEach((x) => take(x.file));
    (c.lessons || []).forEach((l) => (l.items || []).forEach(take));
    for (const x of await allFor(store, `sub:${c.id}:`)) (x.files || []).forEach(take);
    for (const m of await allFor(store, `msg:${c.id}:`)) take(m.file);
    await tryRemove(paths);
    await store.delPrefix(`sub:${c.id}:`); await store.delPrefix(`msg:${c.id}:`); await store.del('book:' + c.id);
    if (c.code) await store.del('code:' + normCode(c.code));
    await store.del('course:' + c.id);
  };
  const dashboard = async (extra) => {
    const out = [];
    for (const c of await allCourses(store)) out.push(await courseCard(store, c));
    out.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    return [200, { lecturer: { name: lec.name, email: lec.email, ownCode: !!lec.hash, mailReady: !!(env.RESEND_API_KEY && env.MAIL_FROM) }, courses: out, ...extra }];
  };
  if (['dashboard', 'courseCreate', 'courseDelete', 'profileSave', 'lecturerCode'].includes(action)) {
    if (!L) return deny();
    if (action === 'courseCreate') {
      if ((await allCourses(store)).length >= MAX_COURSES) return [400, { error: 'too-many' }];
      const id = randId(12);
      const code = await issueStudentCode(store, env, id);
      const now = new Date().toISOString();
      await store.set('course:' + id, { id, title: line(body.title, 160), about: txt(body.about, 1200), syllabus: { text: '', items: [] }, lessons: [], code: code.code, createdAt: now, updatedAt: now });
      return dashboard({ created: id });
    }
    if (action === 'courseDelete') {
      const c = validId(body.cid) ? await store.get('course:' + body.cid) : null;
      if (!c) return [404, { error: 'missing' }];
      await removeCourse(c);
    }
    if (action === 'profileSave') {
      const name = line(body.name, 120), email = line(body.email, 254);
      if (!name) return [400, { error: 'name' }];
      if (email && !EMAIL_RE.test(email)) return [400, { error: 'email' }];
      const rec = (await store.get('lecturer')) || {};
      await store.set('lecturer', { ...rec, name, email });
      Object.assign(lec, { name, email });
    }
    if (action === 'lecturerCode') { // קוד מרצה חדש — מחליף את הקוד הקודם (וגם את LECTURER_CODE)
      const c = normCode(body.code);
      if (c.length < 8 || c.length > 24) return [400, { error: 'lect-format' }];
      if (await store.get('code:' + c)) return [400, { error: 'code-taken' }];
      const rec = (await store.get('lecturer')) || {};
      const h = hashCode(c);
      await store.set('lecturer', { ...rec, name: lec.name, email: lec.email, ...h });
      Object.assign(lec, h);
    }
    return dashboard();
  }

  const cid = body.cid;
  const course = validId(cid) ? await store.get('course:' + cid) : null;
  if (!course) return [404, { error: 'no such course' }];
  if (!L && t.cid !== cid) return deny();
  const sid = t.s;
  const own = L ? 'lecturer' : sid; // תיקיית ההעלאות של מי ששולח/ת
  const save = async () => { course.updatedAt = new Date().toISOString(); await store.set('course:' + cid, course); };

  if (action === 'get') {
    const v = courseView(course, lec, L ? 'l' : 's');
    if (L) {
      v.newSubs = (await allFor(store, `sub:${cid}:`)).filter((x) => !x.seen).length;
      v.newMsgs = (await allFor(store, `msg:${cid}:`)).filter((x) => !x.seen).length;
      v.mailReady = !!(env.RESEND_API_KEY && env.MAIL_FROM) && EMAIL_RE.test(lec.email || '');
    }
    return [200, v];
  }

  // ── כתובת להעלאת קובץ (העלאה ישירה מהדפדפן) ──
  if (action === 'upload') {
    const purpose = body.purpose;
    if (!LIMITS[purpose]) return [400, { error: 'purpose' }];
    if (purpose === 'mat' && !L) return deny();
    const size = Number(body.size) || 0;
    if (size <= 0) return [400, { error: 'empty' }];
    if (size > LIMITS[purpose]) return [413, { error: 'too-big', max: LIMITS[purpose] }];
    const ext = (String(body.name || '').match(/\.([a-z0-9]{1,8})$/i) || [, 'bin'])[1].toLowerCase();
    const path = purpose === 'mat' ? `c/${cid}/mat/${randId(14)}.${ext}` : `c/${cid}/${purpose}/${own}/${randId(14)}.${ext}`;
    const parts = Math.ceil(size / CHUNK);
    await store.set('fm:' + path, { size, parts, type: line(body.type, 120) });
    return [200, { path, parts, chunk: CHUNK, ticket: await sign(store, { k: 'up', p: path, n: parts, z: size }) }];
  }

  // ── כתובת לצפייה או להורדה (15 דקות) ──
  if (action === 'file') {
    const path = String(body.path || '');
    const m = path.match(/^c\/([a-z0-9]+)\/(mat|sub|msg)\/(?:([a-z0-9]+)\/)?[a-z0-9]+\.[a-z0-9]+$/);
    if (!m || m[1] !== cid) return [400, { error: 'path' }];
    if (m[2] !== 'mat' && !L && m[3] !== sid) return deny();
    const fm = await store.get('fm:' + path);
    if (!fm) return [404, { error: 'missing' }];
    return [200, { ...fm, ticket: await sign(store, { k: 'dl', p: path, n: fm.parts }) }];
  }

  // ── הגשות: רק המרצה רואה (וכל סטודנט/ית — את מה שהגיש/ה מהמכשיר שלו/ה) ──
  if (action === 'submit') {
    const fl = (Array.isArray(body.files) ? body.files : []).slice(0, MAX_SUB_FILES).map(fileOf)
      .filter((f) => f && f.path.startsWith(`c/${cid}/sub/${own}/`) && safePath(f.path));
    const link = safeUrl(body.link);
    if (!fl.length && !link) return [400, { error: 'empty' }];
    // כל הגשה: שם מרשימת הקורס ומשימה — כך הפנקס מתעדכן לבד. בלי זה ההגשה לא נשמרת.
    const task = (course.tasks || []).find((t) => t.id === body.taskId);
    if (!task) return [400, { error: 'task' }];
    const lesson = (course.lessons || []).find((l) => l.id === (task ? task.lessonId : body.lessonId));
    // מי הגיש/ה: מהרשימה של המרצה. במשימת צוות — כל חברי הצוות שסומנו.
    const roster = new Set((course.roster || []).map((x) => x.id));
    let studentIds = (Array.isArray(body.studentIds) ? body.studentIds : []).filter((x) => roster.has(x));
    studentIds = [...new Set(task && task.team ? studentIds : studentIds.slice(0, 1))].slice(0, 12);
    if (!studentIds.length) return [400, { error: 'name' }];
    const names = studentIds.map((x) => course.roster.find((y) => y.id === x).name);
    const sub = { id: Date.now().toString(36) + randId(6), sid, name: names.join(', '), studentIds,
      taskId: task.id, taskTitle: task.title, lessonId: lesson ? lesson.id : '', lessonTitle: lesson ? lesson.title : '',
      title: line(body.title, 200), note: txt(body.note, 2000), link, files: fl, at: new Date().toISOString(), seen: false };
    await store.set(`sub:${cid}:${sub.id}`, sub);
    return [200, { ok: true, sub }];
  }
  if (action === 'mySubs') return [200, { subs: (await allFor(store, `sub:${cid}:`)).filter((x) => x.sid === sid) }];
  if (action === 'subs') return L ? [200, { subs: await allFor(store, `sub:${cid}:`) }] : deny();
  if (action === 'subSeen' || action === 'subDelete') {
    const key = `sub:${cid}:${String(body.id || '').replace(/[^a-z0-9]/g, '')}`;
    const sub = await store.get(key);
    if (!sub) return [404, { error: 'missing' }];
    if (action === 'subSeen') { if (!L) return deny(); sub.seen = body.seen !== false; await store.set(key, sub); return [200, { ok: true }]; }
    if (!L && sub.sid !== sid) return deny();
    await tryRemove((sub.files || []).map((f) => f.path));
    await store.del(key);
    return [200, { ok: true }];
  }

  // ── הודעה למרצה ──
  if (action === 'message') {
    const name = line(body.name, 120), text = txt(body.text, 5000);
    if (!name || !text) return [400, { error: 'empty' }];
    const email = line(body.email, 254);
    const recent = (await allFor(store, `msg:${cid}:`)).filter((x) => x.sid === sid && Date.now() - Date.parse(x.at) < 3600e3);
    if (recent.length >= 10) return [429, { error: 'slow-down' }];
    const f = fileOf(body.file);
    const file = f && f.path.startsWith(`c/${cid}/msg/${own}/`) && safePath(f.path) ? f : null;
    const msg = { id: Date.now().toString(36) + randId(6), sid, name, email: EMAIL_RE.test(email) ? email : '', text, link: safeUrl(body.link), file, at: new Date().toISOString(), seen: false, mailed: false };
    let fileData = null; // קובץ עד 8MB מצורף גם למייל
    if (file) {
      try {
        const fm = await store.get('fm:' + file.path);
        if (fm && fm.size <= 8 * MB) {
          const bufs = [];
          for (let n = 0; n < fm.parts; n++) { const b = await getFiles().get(file.path + '/' + n); if (!b) throw new Error('missing part'); bufs.push(Buffer.from(b)); }
          fileData = Buffer.concat(bufs);
        }
      } catch (e) { console.error('files: ' + e.message); }
    }
    msg.mailed = await mailLecturer(env, lec, course, msg, fileData, ctx.siteUrl || '');
    await store.set(`msg:${cid}:${msg.id}`, msg);
    return [200, { ok: true, mailed: msg.mailed }];
  }
  if (action === 'messages') return L ? [200, { msgs: await allFor(store, `msg:${cid}:`) }] : deny();
  if (action === 'msgSeen' || action === 'msgDelete') {
    if (!L) return deny();
    const key = `msg:${cid}:${String(body.id || '').replace(/[^a-z0-9]/g, '')}`;
    const msg = await store.get(key);
    if (!msg) return [404, { error: 'missing' }];
    if (action === 'msgSeen') { msg.seen = body.seen !== false; await store.set(key, msg); return [200, { ok: true }]; }
    if (msg.file) await tryRemove([msg.file.path]);
    await store.del(key);
    return [200, { ok: true }];
  }

  // ── מכאן: עריכת הקורס — למרצה בלבד ──
  if (!L) return deny();
  const view = () => [200, courseView(course, lec, 'l')];

  // ── רשימת הסטודנטים ──
  if (action === 'rosterAdd' || action === 'rosterRename' || action === 'rosterRemove') {
    course.roster ||= [];
    if (action === 'rosterAdd') {
      const have = new Set(course.roster.map((x) => x.name));
      for (const raw of String(body.text || '').split(/\r?\n|[,;\t]/)) {
        const name = line(raw, 120);
        if (!name || have.has(name) || course.roster.length >= 400) continue;
        have.add(name); course.roster.push({ id: randId(8), name });
      }
      course.roster.sort((a, b) => a.name.localeCompare(b.name, 'he'));
    } else {
      const x = course.roster.find((y) => y.id === body.id);
      if (!x) return [404, { error: 'missing' }];
      if (action === 'rosterRename') { const n = line(body.name, 120); if (!n) return [400, { error: 'name' }]; x.name = n; }
      else course.roster = course.roster.filter((y) => y !== x);
    }
    await save();
    return view();
  }

  // ── משימות: שם, הסבר, מועד הגשה, משימת צוות, שיעור קשור ──
  if (action === 'taskSave' || action === 'taskDelete') {
    course.tasks ||= [];
    const prev = course.tasks.find((t) => t.id === (body.task?.id || body.id));
    if (action === 'taskDelete') {
      if (!prev) return [404, { error: 'missing' }];
      course.tasks = course.tasks.filter((t) => t !== prev);
    } else {
      const x = body.task || {};
      const t = { id: prev ? prev.id : randId(8), title: line(x.title, 160), about: txt(x.about, 3000),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || '')) ? x.due : '', team: !!x.team,
        lessonId: (course.lessons || []).some((l) => l.id === x.lessonId) ? x.lessonId : '', createdAt: prev ? prev.createdAt : new Date().toISOString() };
      if (!t.title) return [400, { error: 'name' }];
      if (prev) course.tasks[course.tasks.indexOf(prev)] = t;
      else { if (course.tasks.length >= 80) return [400, { error: 'too-many' }]; course.tasks.push(t); }
      course.tasks.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    }
    await save();
    return view();
  }

  // ── הפנקס: ציונים, הערות לעצמה, הערה לכל סטודנט/ית, והגשות ──
  const bookKey = 'book:' + cid;
  const getBook = async () => ({ grades: {}, notes: '', studentNotes: {}, ...((await store.get(bookKey)) || {}) });
  if (action === 'book') return [200, { ...(await getBook()), subs: await allFor(store, `sub:${cid}:`) }];
  if (action === 'gradeSet' || action === 'notesSave' || action === 'studentNote') {
    const b = await getBook();
    if (action === 'gradeSet') {
      if (!(course.tasks || []).some((t) => t.id === body.taskId) || !(course.roster || []).some((x) => x.id === body.studentId)) return [404, { error: 'missing' }];
      const g = line(body.grade, 20);
      b.grades[body.taskId] ||= {};
      if (g) b.grades[body.taskId][body.studentId] = g; else delete b.grades[body.taskId][body.studentId];
    }
    if (action === 'notesSave') b.notes = txt(body.notes, 20000);
    if (action === 'studentNote') {
      if (!(course.roster || []).some((x) => x.id === body.studentId)) return [404, { error: 'missing' }];
      const n = txt(body.note, 3000);
      if (n) b.studentNotes[body.studentId] = n; else delete b.studentNotes[body.studentId];
    }
    await store.set(bookKey, b);
    return [200, { ok: true }];
  }
  // שיוך הגשה (למשל כשהשם לא היה ברשימה) — לסטודנטים ולמשימה
  if (action === 'subAssign') {
    const key = `sub:${cid}:${String(body.id || '').replace(/[^a-z0-9]/g, '')}`;
    const sub = await store.get(key);
    if (!sub) return [404, { error: 'missing' }];
    const roster = new Set((course.roster || []).map((x) => x.id));
    sub.studentIds = [...new Set((Array.isArray(body.studentIds) ? body.studentIds : []).filter((x) => roster.has(x)))];
    const task = (course.tasks || []).find((t) => t.id === body.taskId);
    if ('taskId' in body) { sub.taskId = task ? task.id : ''; sub.taskTitle = task ? task.title : ''; }
    if (sub.studentIds.length) sub.name = sub.studentIds.map((x) => course.roster.find((y) => y.id === x).name).join(', ');
    await store.set(key, sub);
    return [200, { ok: true, sub }];
  }

  // ── לוח ההודעות של המרצה: טקסט, ואפשר לצרף תמונה/קובץ וקישור ──
  if (action === 'postSave' || action === 'postDelete') {
    course.posts ||= [];
    const prev = course.posts.find((x) => x.id === body.post?.id || x.id === body.id);
    if (action === 'postDelete') {
      if (!prev) return [404, { error: 'missing' }];
      course.posts = course.posts.filter((x) => x !== prev);
      if (prev.file) await tryRemove([prev.file.path]);
      await save();
      return view();
    }
    const x = body.post || {};
    const f = 'file' in x ? fileOf(x.file) : prev?.file || null;
    const file = f && f.path.startsWith(`c/${cid}/mat/`) && safePath(f.path) ? f : null;
    const post = { id: prev ? prev.id : Date.now().toString(36) + randId(4), title: line(x.title, 160), text: txt(x.text, 6000),
      link: safeUrl(x.link), linkTitle: line(x.linkTitle, 160), file, pinned: !!x.pinned, at: prev ? prev.at : new Date().toISOString() };
    if (prev) post.editedAt = new Date().toISOString();
    if (!post.text && !post.file && !post.link) return [400, { error: 'empty' }];
    if (prev && prev.file && (!file || prev.file.path !== file.path)) await tryRemove([prev.file.path]);
    if (prev) course.posts[course.posts.indexOf(prev)] = post;
    else { if (course.posts.length >= 100) return [400, { error: 'too-many' }]; course.posts.unshift(post); }
    await save();
    return view();
  }

  if (action === 'save') {
    const p = body.patch || {};
    if ('title' in p) course.title = line(p.title, 160);
    if ('about' in p) course.about = txt(p.about, 1200);
    if ('syllabus' in p) course.syllabus = { ...(course.syllabus || { items: [] }), text: txt(p.syllabus, 30000) };
    await save();
    return view();
  }
  if (action === 'studentCode') {
    const old = course.code;
    const out = await issueStudentCode(store, env, cid, body.code ? String(body.code) : '');
    if (out.error) return [400, out];
    if (old) await store.del('code:' + normCode(old));
    course.code = out.code;
    await save();
    return view();
  }
  if (action === 'lessonSave') {
    const x = body.lesson || {};
    course.lessons ||= [];
    let l = course.lessons.find((y) => y.id === x.id);
    if (!l) {
      if (course.lessons.length >= MAX_LESSONS) return [400, { error: 'too-many' }];
      l = { id: randId(10), items: [] };
      course.lessons.push(l);
    }
    l.title = line(x.title, 200) || 'שיעור ' + (course.lessons.indexOf(l) + 1);
    l.date = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? x.date : '';
    l.about = txt(x.about, 3000);
    l.task = !!x.task;
    await save();
    return [200, { ...courseView(course, lec, 'l'), saved: l.id }];
  }
  if (action === 'lessonDelete' || action === 'lessonMove') {
    const i = (course.lessons || []).findIndex((y) => y.id === body.lessonId);
    if (i < 0) return [404, { error: 'missing' }];
    if (action === 'lessonMove') {
      const j = i + (body.dir === 'up' ? -1 : 1);
      if (j >= 0 && j < course.lessons.length) [course.lessons[i], course.lessons[j]] = [course.lessons[j], course.lessons[i]];
    } else {
      const [gone] = course.lessons.splice(i, 1);
      await tryRemove((gone.items || []).filter((it) => it.path).map((it) => it.path));
    }
    await save();
    return view();
  }
  // פריט (קובץ או קישור) בשיעור או בסילבוס. where = 'syllabus' או מזהה שיעור.
  if (action === 'itemSave' || action === 'itemDelete' || action === 'itemMove') {
    const host = body.where === 'syllabus' ? (course.syllabus ||= { text: '', items: [] }) : (course.lessons || []).find((l) => l.id === body.where);
    if (!host) return [404, { error: 'missing' }];
    host.items ||= [];
    if (action === 'itemSave') {
      const prev = host.items.find((y) => y.id === body.item?.id);
      if (prev) { // עריכה: כותרת, הערה, כתובת. קובץ שהוחלף — הישן נמחק.
        const merged = cleanItem({ ...prev, ...body.item, id: prev.id }, cid);
        if (!merged) return [400, { error: 'item' }];
        if (prev.path && merged.path !== prev.path) await tryRemove([prev.path]);
        merged.at = prev.at;
        host.items[host.items.indexOf(prev)] = merged;
      } else {
        if (host.items.length >= MAX_ITEMS) return [400, { error: 'too-many' }];
        const it = cleanItem({ ...body.item, id: undefined }, cid);
        if (!it) return [400, { error: 'item' }];
        host.items.push(it);
      }
    } else {
      const i = host.items.findIndex((y) => y.id === body.itemId);
      if (i < 0) return [404, { error: 'missing' }];
      if (action === 'itemMove') {
        const j = i + (body.dir === 'up' ? -1 : 1);
        if (j >= 0 && j < host.items.length) [host.items[i], host.items[j]] = [host.items[j], host.items[i]];
      } else {
        const [gone] = host.items.splice(i, 1);
        if (gone.path) await tryRemove([gone.path]);
      }
    }
    await save();
    return view();
  }

  return [400, { error: 'unknown action' }];
}

// ── חלקי קבצים: PUT (העלאה) ו-GET (הורדה) של חלק n, עם כרטיס חתום ──
// מחזיר [status, body], כש-body הוא ArrayBuffer בהורדה.
export async function handleChunk(method, ticket, n, bytes, ctx) {
  const t = await verify(ctx.store, ticket);
  n = Number(n);
  if (!t || !Number.isInteger(n) || n < 0 || n >= t.n || !safePath(t.p)) return [403, { error: 'ticket' }];
  const key = t.p + '/' + n;
  if (method === 'PUT') {
    if (t.k !== 'up' || !bytes) return [403, { error: 'ticket' }];
    const want = n < t.n - 1 ? CHUNK : t.z - CHUNK * (t.n - 1);
    if (bytes.byteLength !== want) return [400, { error: 'size' }];
    await ctx.files.put(key, bytes);
    return [200, { ok: true }];
  }
  if (method === 'GET' && t.k === 'dl') {
    const b = await ctx.files.get(key);
    return b ? [200, b] : [404, { error: 'missing' }];
  }
  return [405, { error: 'method' }];
}
