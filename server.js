// InterviewOS web app: dashboard API + device API for the Raspberry Pi kiosk.
// Runs on Vercel (Express zero-config) and locally with `node server.js`.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

loadDotEnv(['.env', '.env.local']);

const { waitUntil } = require('@vercel/functions');
const { db } = require('./lib/db');
const blob = require('./lib/blob');
const cache = require('./lib/cache');
const ai = require('./lib/ai');
const { cleanPcm, pcmToWav, asciiOnly } = require('./lib/audio');

const DEVICE_ONLINE_MS = 45_000;
const COOKIE = 'ios_session';
const COOKIE_DAYS = 30;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
// Local run: serve the dashboard files (on Vercel the CDN serves public/).
if (!process.env.VERCEL) app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────── helpers

function loadDotEnv(files) {
  for (const f of files) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const later = p => waitUntil(Promise.resolve(p).catch(err => console.error('[background]', err.message)));

function safeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function normCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z0-9-]{3,20}$/.test(c) ? c : null;
}

function cleanSid(sid) {
  const s = String(sid || '').toLowerCase();
  return /^[a-f0-9]{8,32}$/.test(s) ? s : null;
}

// 6-digit numeric codes so they can be typed on the device keypad.
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

// ───────────────────────────── auth

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(value).digest('base64url');
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function adminUser(req) {
  const c = readCookie(req, COOKIE);
  if (!c || !process.env.SESSION_SECRET) return null;
  const i = c.lastIndexOf('.');
  if (i < 0) return null;
  const value = c.slice(0, i);
  if (!safeEq(c.slice(i + 1), sign(value))) return null;
  const j = value.lastIndexOf('.');
  const user = value.slice(0, j);
  if (!(Number(value.slice(j + 1)) > Date.now())) return null;
  return user;
}

function setSessionCookie(res, user) {
  const value = `${user}.${Date.now() + COOKIE_DAYS * 86400_000}`;
  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(`${value}.${sign(value)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure}`);
}

function isDevice(req) {
  const token = process.env.DEVICE_TOKEN;
  return !!token && safeEq(req.get('x-device-token') || '', token);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass || !process.env.SESSION_SECRET) {
    return res.status(500).json({ error: 'Login is not configured on the server.' });
  }
  if (!safeEq(String(username || '').trim().toLowerCase(), user.toLowerCase()) || !safeEq(String(password || ''), pass)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  setSessionCookie(res, user);
  res.json({ username: user });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.status(204).end();
});

app.get('/api/me', (req, res) => res.json({ username: adminUser(req) }));

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/device/')) {
    if (isDevice(req)) {
      req.isDevice = true;
      later(cache.set('device', {
        at: Date.now(),
        version: String(req.get('x-device-version') || '').slice(0, 40),
        info: String(req.get('x-device-info') || '').slice(0, 200),
      }, 86400));
      return next();
    }
    if (req.path === '/device/status' && adminUser(req)) return next();
    return res.status(401).type('text/plain').send('ERR|Bad device token');
  }
  if (adminUser(req)) return next();
  res.status(401).json({ error: 'Please sign in.' });
});


// ───────────────────────────── data access

async function getTest(code) {
  code = normCode(code);
  if (!code) return null;
  const key = `test:${code}`;
  const hit = await cache.get(key);
  if (hit && hit.code) return hit;
  const rows = await db`SELECT code, title, role, duration_minutes, questions, created_at FROM tests WHERE code = ${code}`;
  const t = rows[0];
  if (!t) return null;
  t.created_at = iso(t.created_at);
  await cache.set(key, t, 600);
  return t;
}

async function setLive(code, fields, replace = false) {
  const key = `live:${code}`;
  const prev = replace ? {} : (await cache.get(key)) || {};
  await cache.set(key, { ...prev, ...fields, updated_at: new Date().toISOString() }, 3 * 3600);
}

function audioUrl(audioPath) {
  return audioPath ? `/api/audio?path=${encodeURIComponent(audioPath)}` : null;
}

// ───────────────────────────── dashboard API

app.post('/api/generate-questions', h(async (req, res) => {
  const { role, topics, n, difficulty } = req.body || {};
  if (!role) return res.status(400).json({ error: 'role required' });
  const count = Math.max(1, Math.min(20, Number(n) || 6));
  try {
    res.json(await ai.generateQuestions({ role, topics, count, difficulty }));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

app.get('/api/tests', h(async (req, res) => {
  const rows = await db`
    SELECT t.code, t.title, t.role, t.duration_minutes, t.created_at,
           jsonb_array_length(t.questions)::int AS question_count,
           (SELECT count(*)::int FROM submissions s WHERE s.test_code = t.code) AS submission_count
    FROM tests t ORDER BY t.created_at DESC`;
  res.json(rows.map(r => ({ ...r, created_at: iso(r.created_at) })));
}));

app.post('/api/tests', h(async (req, res) => {
  const { title, role, duration_minutes, questions } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'title and at least one question required' });
  }
  const qs = questions.slice(0, 50).map((q, i) => ({
    id: i + 1,
    text: String(q.text || '').slice(0, 2000),
    time_limit_seconds: Math.max(10, Math.min(900, Number(q.time_limit_seconds) || 180)),
    expected_topics: Array.isArray(q.expected_topics) ? q.expected_topics.slice(0, 10).map(String) : [],
  }));
  let created = null;
  for (let attempt = 0; attempt < 20 && !created; attempt++) {
    const rows = await db`
      INSERT INTO tests (code, title, role, duration_minutes, questions)
      VALUES (${generateCode()}, ${String(title).slice(0, 200)}, ${role ? String(role).slice(0, 200) : ''},
              ${Number(duration_minutes) || 60}, ${JSON.stringify(qs)}::jsonb)
      ON CONFLICT (code) DO NOTHING
      RETURNING code, title, role, duration_minutes, questions, created_at`;
    created = rows[0] || null;
  }
  if (!created) return res.status(500).json({ error: 'Could not allocate a test code' });
  created.created_at = iso(created.created_at);
  later(prewarmSpeech(created));
  res.status(201).json({ ...created, responses: [] });
}));

app.get('/api/tests/:code', h(async (req, res) => {
  const test = await getTest(req.params.code);
  if (!test) return res.status(404).json({ error: 'not found' });
  const subs = await db`
    SELECT id, candidate_name, submitted_at, answers, overall_score
    FROM submissions WHERE test_code = ${test.code} ORDER BY submitted_at ASC`;
  const responses = subs.map(s => ({
    id: s.id,
    candidate_name: s.candidate_name,
    submitted_at: iso(s.submitted_at),
    overall_score: s.overall_score,
    answers: (s.answers || []).map(a => ({
      question_id: a.question_id,
      transcript: a.transcript || '',
      audio_url: audioUrl(a.audio_path),
      score: typeof a.score === 'number' ? a.score : null,
      feedback: a.feedback || '',
    })),
  }));
  later(healTest(test.code));
  res.json({ ...test, responses });
}));

app.delete('/api/tests/:code', h(async (req, res) => {
  const code = normCode(req.params.code);
  const rows = code ? await db`DELETE FROM tests WHERE code = ${code} RETURNING code` : [];
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  await cache.del(`test:${code}`);
  await cache.del(`live:${code}`);
  later(blob.removePrefix(`recordings/${code}/`));
  res.status(204).end();
}));

app.get('/api/tests/:code/state', h(async (req, res) => {
  const test = await getTest(req.params.code);
  if (!test) return res.status(404).json({ error: 'not found' });
  const state = (await cache.get(`live:${test.code}`)) || { phase: 'idle' };
  res.json({
    ...state,
    test: {
      code: test.code,
      title: test.title,
      role: test.role,
      duration_minutes: test.duration_minutes,
      total_questions: test.questions.length,
      questions: test.questions,
    },
  });
}));

// Recordings are private; the browser gets a short-lived signed link.
app.get('/api/audio', h(async (req, res) => {
  const p = String(req.query.path || '');
  if (!/^recordings\/[A-Za-z0-9_\-/]+\.wav$/.test(p) || p.includes('..')) return res.status(400).end();
  try {
    return res.redirect(302, await blob.signedReadUrl(p));
  } catch (err) {
    console.error('[audio] signed url failed, streaming instead:', err.message);
  }
  const r = await blob.stream(p);
  if (!r) return res.status(404).end();
  res.set('Content-Type', 'audio/wav');
  if (r.blob && r.blob.size) res.set('Content-Length', String(r.blob.size));
  Readable.fromWeb(r.stream).pipe(res);
}));

app.get('/api/device/status', h(async (req, res) => {
  const d = await cache.get('device');
  res.json({
    online: !!d && Date.now() - d.at < DEVICE_ONLINE_MS,
    last_seen_at: d ? iso(d.at) : null,
    version: d ? d.version : null,
    info: d ? d.info : null,
  });
}));

// ───────────────────────────── speech (text-to-speech, cached in Blob)

const ttsInflight = new Map();

function getSpeech(text) {
  const p = ai.ttsPath(text);
  if (!ttsInflight.has(p)) {
    const job = (async () => {
      const cached = await blob.read(p);
      if (cached) return cached;
      const pcm = await ai.ttsPcm(text);
      await blob.write(p, pcm, 'application/octet-stream');
      return pcm;
    })().finally(() => ttsInflight.delete(p));
    ttsInflight.set(p, job);
  }
  return ttsInflight.get(p);
}

async function prewarmSpeech(test) {
  const key = `warm:${test.code}`;
  if (await cache.get(key)) return;
  await cache.set(key, 1, 600);
  for (const k of ai.speechKeys(test)) {
    const text = ai.speechText(test, k);
    try {
      if (!(await blob.exists(ai.ttsPath(text)))) await getSpeech(text);
    } catch (err) {
      console.error('[tts]', test.code, k, err.message);
    }
  }
}

// ───────────────────────────── answers, transcripts, scoring

async function transcribeAnswer(sid, qn, wav, final) {
  try {
    if (!wav) {
      const rows = await db`SELECT audio_path FROM answers WHERE session_id = ${sid} AND qn = ${qn}`;
      wav = rows[0] && rows[0].audio_path ? await blob.read(rows[0].audio_path, { fresh: true }) : null;
      if (!wav) throw new Error('recording missing');
    }
    const text = await ai.transcribeWav(wav);
    await db`UPDATE answers SET status = 'done', transcript = ${text}, updated_at = now()
             WHERE session_id = ${sid} AND qn = ${qn}`;
  } catch (err) {
    console.error(`[whisper] ${sid} q${qn}:`, err.message);
    await db`UPDATE answers SET status = ${final ? 'failed' : 'error'}, updated_at = now()
             WHERE session_id = ${sid} AND qn = ${qn}`;
  }
}

async function saveAnswer(session, test, qn, pcm) {
  const q = test.questions[qn - 1];
  const seconds = Math.round((pcm.length / 32000) * 10) / 10;
  const clean = cleanPcm(pcm);
  if (!clean) {
    await db`
      INSERT INTO answers (session_id, qn, question_id, status, audio_path, transcript, seconds)
      VALUES (${session.id}, ${qn}, ${q.id}, 'silent', NULL, '', ${seconds})
      ON CONFLICT (session_id, qn) DO UPDATE
        SET status = 'silent', audio_path = NULL, transcript = '', seconds = EXCLUDED.seconds, updated_at = now()`;
    console.log(`[device] ${test.code} ${session.candidate_name} q${qn}: ${seconds}s (silent)`);
    return;
  }
  const wav = pcmToWav(clean, 16000);
  const audioPath = `recordings/${test.code}/${session.id}-q${qn}.wav`;
  await blob.write(audioPath, wav, 'audio/wav');
  await db`
    INSERT INTO answers (session_id, qn, question_id, status, audio_path, transcript, seconds)
    VALUES (${session.id}, ${qn}, ${q.id}, 'pending', ${audioPath}, '', ${seconds})
    ON CONFLICT (session_id, qn) DO UPDATE
      SET status = 'pending', audio_path = EXCLUDED.audio_path, transcript = '', seconds = EXCLUDED.seconds, updated_at = now()`;
  console.log(`[device] ${test.code} ${session.candidate_name} q${qn}: ${seconds}s`);
  later(transcribeAnswer(session.id, qn, wav, false));
}

async function scoreSubmission(id) {
  const rows = await db`SELECT id, test_code, answers FROM submissions WHERE id = ${id}`;
  const sub = rows[0];
  if (!sub) return;
  const test = await getTest(sub.test_code);
  if (!test) return;
  const answers = sub.answers || [];
  await Promise.all(answers.map(async ans => {
    if (typeof ans.score === 'number') return;
    const q = test.questions.find(qq => qq.id === ans.question_id);
    if (!q) return;
    if (!String(ans.transcript || '').trim()) {
      ans.score = 0;
      ans.feedback = 'No answer was recorded.';
      return;
    }
    try {
      Object.assign(ans, await ai.scoreOneAnswer({ role: test.role || test.title, question: q.text, transcript: ans.transcript }));
    } catch (err) {
      console.error(`[score] q${ans.question_id}:`, err.message);
    }
  }));
  const scored = answers.filter(a => typeof a.score === 'number');
  const overall = scored.length
    ? Math.round((scored.reduce((s, a) => s + a.score, 0) / scored.length) * 10) / 10
    : null;
  await db`UPDATE submissions SET answers = ${JSON.stringify(answers)}::jsonb, overall_score = ${overall} WHERE id = ${id}`;
  console.log(`[score] ${test.code} ${id.slice(0, 8)} overall=${overall}`);
}

// Wait for transcripts, then save the submission and score it. Safe to run twice.
async function finalizeSession(sid) {
  const srows = await db`SELECT id, test_code, candidate_name, finished_at FROM sessions WHERE id = ${sid}`;
  const s = srows[0];
  if (!s) return;
  const test = await getTest(s.test_code);
  if (!test) return;

  const deadline = Date.now() + 150_000;
  let rows;
  for (;;) {
    rows = await db`SELECT qn, status, audio_path, transcript, seconds, updated_at FROM answers WHERE session_id = ${sid}`;
    const now = Date.now();
    const stale = rows.filter(a => a.status === 'error' ||
      (a.status === 'pending' && now - new Date(a.updated_at).getTime() > 40_000));
    if (stale.length && now < deadline) {
      await Promise.all(stale.map(a => transcribeAnswer(sid, a.qn, null, true)));
      continue;
    }
    if (!rows.some(a => a.status === 'pending') || now >= deadline) break;
    await sleep(1500);
  }

  const byQn = new Map(rows.map(a => [a.qn, a]));
  const answers = test.questions.map((q, i) => {
    const a = byQn.get(i + 1);
    return {
      question_id: q.id,
      transcript: a && a.status === 'done' ? a.transcript : '',
      audio_path: a ? a.audio_path : null,
      seconds: a ? a.seconds : null,
      score: null,
      feedback: '',
    };
  });
  const id = crypto.randomUUID();
  const inserted = await db`
    INSERT INTO submissions (id, test_code, session_id, candidate_name, submitted_at, answers)
    VALUES (${id}, ${test.code}, ${sid}, ${s.candidate_name}, ${iso(s.finished_at || new Date())}, ${JSON.stringify(answers)}::jsonb)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING id`;
  if (inserted.length) {
    console.log(`[device] ${test.code} ${s.candidate_name} submitted, scoring...`);
    await scoreSubmission(id);
  }
}

// Self-healing: finish anything a crashed/timed-out background job left behind.
async function healTest(code) {
  const key = `heal:${code}`;
  if (await cache.get(key)) return;
  await cache.set(key, 1, 60);
  const stuck = await db`
    SELECT s.id FROM sessions s
    LEFT JOIN submissions sub ON sub.session_id = s.id
    WHERE s.test_code = ${code} AND s.finished_at IS NOT NULL
      AND s.finished_at < now() - interval '4 minutes' AND sub.id IS NULL
    LIMIT 5`;
  for (const r of stuck) await finalizeSession(r.id);
  const unscored = await db`
    SELECT id FROM submissions
    WHERE test_code = ${code} AND overall_score IS NULL AND submitted_at < now() - interval '4 minutes'
    LIMIT 5`;
  for (const r of unscored) await scoreSubmission(r.id);
}

// ───────────────────────────── device API (Raspberry Pi kiosk)
// Every request carries the X-Device-Token header.

app.get('/api/device/ping', (req, res) => res.type('text/plain').send('OK'));

// Plain-text test fetch:
//   OK|<count>|<title>
//   <n>|<seconds>|<question text>
app.get('/api/device/tests/:code', h(async (req, res) => {
  const test = await getTest(req.params.code);
  res.type('text/plain');
  if (!test) return res.status(404).send('ERR|Test not found\n');
  let out = `OK|${test.questions.length}|${asciiOnly(test.title)}\n`;
  test.questions.forEach((q, i) => { out += `${i + 1}|${q.time_limit_seconds}|${asciiOnly(q.text)}\n`; });
  later(prewarmSpeech(test));
  res.send(out);
}));

// Start one student's attempt. The Pi may pass its own ?sid= so it can work offline
// and sync later; otherwise a new id is generated. Returns the session id.
app.post('/api/device/tests/:code/sessions', h(async (req, res) => {
  const test = await getTest(req.params.code);
  if (!test) return res.status(404).type('text/plain').send('ERR|Test not found');
  const roll = String(req.query.roll || '').replace(/\D/g, '').slice(0, 20) || 'unknown';
  const sid = cleanSid(req.query.sid) || crypto.randomBytes(8).toString('hex');
  const name = `Roll ${roll}`;
  await db`INSERT INTO sessions (id, test_code, candidate_name) VALUES (${sid}, ${test.code}, ${name})
           ON CONFLICT (id) DO NOTHING`;
  if (req.query.live !== '0') {
    await setLive(test.code, { phase: 'welcome', candidate_name: name, total_questions: test.questions.length, current_question_index: -1 }, true);
  }
  console.log(`[device] ${test.code} start - ${name} - session ${sid}`);
  res.type('text/plain').send(sid);
}));

// Question audio: raw PCM 24 kHz / 16-bit / mono.
app.get('/api/device/tests/:code/speech/:key', h(async (req, res) => {
  const test = await getTest(req.params.code);
  if (!test) return res.status(404).end();
  const text = ai.speechText(test, req.params.key);
  if (!text) return res.status(404).end();
  try {
    const pcm = await getSpeech(text);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'no-store');
    res.send(pcm);
  } catch (err) {
    console.error('[speech]', err.message);
    res.status(502).end();
  }
}));

// Live progress for the dashboard: ?phase=speaking|listening|processing|complete&q=2&secs=60&roll=123
app.post('/api/device/tests/:code/progress', h(async (req, res) => {
  const code = normCode(req.params.code);
  if (!code) return res.status(400).end();
  const phase = String(req.query.phase || '');
  if (!['welcome', 'speaking', 'listening', 'processing', 'complete', 'idle'].includes(phase)) return res.status(400).end();
  const fields = { phase };
  const q = Number(req.query.q);
  if (q >= 1) Object.assign(fields, { current_question_index: q - 1, current_question_id: q });
  if (req.query.total) fields.total_questions = Number(req.query.total);
  if (req.query.roll) fields.candidate_name = `Roll ${String(req.query.roll).replace(/\D/g, '').slice(0, 20)}`;
  if (phase === 'listening') {
    const now = Date.now();
    const secs = Math.max(1, Math.min(900, Number(req.query.secs) || 60));
    fields.listening_started_at = new Date(now).toISOString();
    fields.listening_ends_at = new Date(now + secs * 1000).toISOString();
  }
  await setLive(code, fields, phase === 'welcome');
  res.type('text/plain').send('OK');
}));

// Answer upload: raw PCM 16 kHz / 16-bit / mono. Long answers come in parts
// (?part=0&parts=3) because a single request body is limited to ~4.5 MB.
app.post('/api/device/sessions/:sid/answers/:qn',
  express.raw({ type: () => true, limit: '6mb' }),
  h(async (req, res) => {
    const sid = cleanSid(req.params.sid);
    const qn = Number(req.params.qn);
    const parts = Math.max(1, Math.min(50, Number(req.query.parts) || 1));
    const part = Math.max(0, Number(req.query.part) || 0);
    if (!sid || !(qn >= 1) || part >= parts) return res.status(400).type('text/plain').send('ERR|Bad request');

    const srows = await db`SELECT id, test_code, candidate_name FROM sessions WHERE id = ${sid}`;
    const session = srows[0];
    if (!session) return res.status(404).type('text/plain').send('ERR|No session');
    const test = await getTest(session.test_code);
    if (!test || !test.questions[qn - 1]) return res.status(404).type('text/plain').send('ERR|No question');

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let pcm = body;
    if (parts > 1) {
      const dir = `uploads/${sid}/q${qn}/`;
      const name = i => `${dir}${String(i).padStart(3, '0')}.pcm`;
      await blob.write(name(part), body, 'application/octet-stream');
      if (part < parts - 1) return res.type('text/plain').send(`OK|part ${part + 1}/${parts}`);
      const bufs = [];
      for (let i = 0; i < parts; i++) {
        const b = await blob.read(name(i), { fresh: true });
        if (!b) return res.status(409).type('text/plain').send(`ERR|Missing part ${i}`);
        bufs.push(b);
      }
      pcm = Buffer.concat(bufs);
      later(blob.removePrefix(dir));
    }
    await saveAnswer(session, test, qn, pcm);
    res.type('text/plain').send('OK');
  }));

// Student finished: respond at once, then wait for transcripts, save, and score.
app.post('/api/device/sessions/:sid/finish', h(async (req, res) => {
  const sid = cleanSid(req.params.sid);
  const rows = sid ? await db`UPDATE sessions SET finished_at = COALESCE(finished_at, now()) WHERE id = ${sid} RETURNING test_code` : [];
  if (!rows.length) return res.status(404).type('text/plain').send('ERR|No session');
  if (req.query.live !== '0') await setLive(rows[0].test_code, { phase: 'complete' });
  later(finalizeSession(sid));
  res.type('text/plain').send('OK');
}));

// ───────────────────────────── errors

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// The CDN serves files in public/; anything else that reaches Express goes to the login page.
app.get('/', (req, res) => res.redirect(302, '/index.html'));
app.use((req, res) => res.redirect(302, '/index.html'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.stack || err.message);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/device/')) return res.status(500).type('text/plain').send('ERR|Server error');
  res.status(500).json({ error: err.message || 'Server error' });
});

if (!process.env.VERCEL && require.main === module) {
  const port = process.env.PORT || 5173;
  const server = app.listen(port, '0.0.0.0', () => console.log(`InterviewOS on http://localhost:${port}`));
  server.requestTimeout = 0;
}

module.exports = app;
