// End-to-end check of a deployment, acting as both the dashboard and the Pi.
//   node scripts/smoke-test.js https://interviewos-cpg104.vercel.app path/to/answer.wav
// Creates a throwaway test, runs one interview (one multi-part answer, one
// silent answer), waits for transcript + score, then deletes the test.
require('./load-env');
const fs = require('fs');
const crypto = require('crypto');

const BASE = (process.argv[2] || 'https://interviewos-cpg104.vercel.app').replace(/\/$/, '');
const WAV = process.argv[3];
const DEV = { 'X-Device-Token': process.env.DEVICE_TOKEN || '', 'X-Device-Version': 'smoke' };
let cookie = '';

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) },
    redirect: 'manual',
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r;
}

function ok(cond, msg) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('  ok -', msg);
}

async function main() {
  const pcm = WAV ? fs.readFileSync(WAV).subarray(44) : Buffer.alloc(32000 * 3);
  let r = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD }) });
  ok(r.status === 200, 'dashboard login');

  r = await api('/api/tests', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Smoke test (auto-deleted)', role: 'Computer basics',
      questions: [
        { text: 'Count from one to ten.', time_limit_seconds: 30 },
        { text: 'Stay silent for this one.', time_limit_seconds: 10 },
      ],
    }),
  });
  const test = await r.json();
  ok(r.status === 201 && /^\d{6}$/.test(test.code), `test created (${test.code})`);
  const code = test.code;

  try {
    r = await fetch(`${BASE}/api/device/tests/${code}`, { headers: DEV });
    const text = await r.text();
    ok(text.startsWith('OK|2|'), 'device fetches test');

    for (const key of ['welcome', 'q1', 'q2', 'end']) {
      r = await fetch(`${BASE}/api/device/tests/${code}/speech/${key}`, { headers: DEV });
      const buf = Buffer.from(await r.arrayBuffer());
      ok(r.ok && buf.length > 24000, `speech ${key}: ${(buf.length / 48000).toFixed(1)}s of audio`);
    }

    const sid = crypto.randomBytes(8).toString('hex');
    r = await fetch(`${BASE}/api/device/tests/${code}/sessions?roll=424242&sid=${sid}`, { method: 'POST', headers: DEV });
    ok((await r.text()) === sid, 'session created with Pi-chosen id');

    r = await fetch(`${BASE}/api/device/tests/${code}/progress?phase=listening&q=1&secs=30&total=2`, { method: 'POST', headers: DEV });
    ok(r.ok, 'live progress accepted');

    const CHUNK = Math.ceil(pcm.length / 3);
    const parts = Math.ceil(pcm.length / CHUNK);
    for (let i = 0; i < parts; i++) {
      r = await fetch(`${BASE}/api/device/sessions/${sid}/answers/1?part=${i}&parts=${parts}`, {
        method: 'POST', headers: { ...DEV, 'Content-Type': 'application/octet-stream' }, body: pcm.subarray(i * CHUNK, (i + 1) * CHUNK),
      });
      ok(r.ok, `answer 1 part ${i + 1}/${parts} uploaded (${await r.text()})`);
    }
    r = await fetch(`${BASE}/api/device/sessions/${sid}/answers/2`, {
      method: 'POST', headers: { ...DEV, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(32000 * 2),
    });
    ok(r.ok, 'answer 2 (silent) uploaded');

    r = await fetch(`${BASE}/api/device/sessions/${sid}/finish`, { method: 'POST', headers: DEV });
    ok(r.ok, 'finish accepted');

    r = await api(`/api/tests/${code}/state`);
    ok((await r.json()).phase === 'complete', 'live state shows complete');

    let sub = null;
    for (let i = 0; i < 45 && !(sub && sub.overall_score != null); i++) {
      await new Promise(res => setTimeout(res, 2000));
      const t = await (await api(`/api/tests/${code}`)).json();
      sub = (t.responses || [])[0] || null;
    }
    ok(sub, 'submission saved');
    ok(sub.overall_score != null, `scored: overall ${sub.overall_score}/10`);
    console.log('     transcript q1:', JSON.stringify(sub.answers[0].transcript));
    console.log('     feedback q1:', sub.answers[0].score, '-', sub.answers[0].feedback);
    ok(sub.answers[1].transcript === '' && sub.answers[1].score === 0, 'silent answer scored 0');
    if (sub.answers[0].audio_url) {
      r = await api(sub.answers[0].audio_url);
      const loc = r.headers.get('location') || '';
      ok(r.status === 302 && loc.includes('blob.vercel-storage.com'), 'recording link is a signed private URL');
      const a = await fetch(loc);
      ok(a.ok && (a.headers.get('content-type') || '').includes('audio'), `recording downloads (${a.headers.get('content-length')} bytes)`);
    }
  } finally {
    r = await api(`/api/tests/${code}`, { method: 'DELETE' });
    console.log(r.status === 204 ? '  ok - throwaway test deleted' : `  !! could not delete test ${code}`);
  }
  console.log('ALL GOOD');
}

main().catch(err => {
  console.error(err.message, err.cause ? `(cause: ${err.cause.code || ""} ${err.cause.message})` : "");
  process.exit(1);
});
