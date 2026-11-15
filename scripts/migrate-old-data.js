// One-time copy of the old Mac server's data (tests.json, recordings, TTS cache)
// into Postgres + Vercel Blob. Safe to re-run: existing rows/files are skipped.
//   node scripts/migrate-old-data.js "/path/to/old/Capstone project"
require('./load-env');
const fs = require('fs');
const path = require('path');
const { db } = require('../lib/db');
const blob = require('../lib/blob');

const OLD = process.argv[2];
if (!OLD) {
  console.error('usage: node scripts/migrate-old-data.js <old project folder>');
  process.exit(1);
}

async function main() {
  const tests = JSON.parse(fs.readFileSync(path.join(OLD, 'tests.json'), 'utf-8'));
  let nTests = 0, nSubs = 0, nRec = 0, nTts = 0;

  for (const t of tests) {
    const code = String(t.code).toUpperCase();
    const questions = (t.questions || []).map((q, i) => ({
      id: q.id || i + 1,
      text: String(q.text || ''),
      time_limit_seconds: Number(q.time_limit_seconds) || 180,
      expected_topics: Array.isArray(q.expected_topics) ? q.expected_topics : [],
    }));
    const ins = await db`
      INSERT INTO tests (code, title, role, duration_minutes, questions, created_at)
      VALUES (${code}, ${t.title || code}, ${t.role || ''}, ${Number(t.duration_minutes) || 60},
              ${JSON.stringify(questions)}::jsonb, ${t.created_at || new Date().toISOString()})
      ON CONFLICT (code) DO NOTHING RETURNING code`;
    nTests += ins.length;

    for (const r of t.responses || []) {
      const answers = [];
      for (const a of r.answers || []) {
        let audioPath = null;
        const m = /^\/recordings\/(.+\.wav)$/.exec(a.audio_url || '');
        if (m) {
          const local = path.join(OLD, 'public', 'recordings', m[1]);
          const name = m[1].startsWith(`${code}-`) ? m[1].slice(code.length + 1) : m[1];
          audioPath = `recordings/${code}/${name}`;
          if (fs.existsSync(local)) {
            if (!(await blob.exists(audioPath))) {
              await blob.write(audioPath, fs.readFileSync(local), 'audio/wav');
              nRec++;
            }
          } else {
            audioPath = null;
          }
        }
        answers.push({
          question_id: a.question_id,
          transcript: a.transcript || '',
          audio_path: audioPath,
          score: typeof a.score === 'number' ? a.score : null,
          feedback: a.feedback || '',
        });
      }
      const s = await db`
        INSERT INTO submissions (id, test_code, session_id, candidate_name, submitted_at, answers, overall_score)
        VALUES (${r.id}, ${code}, NULL, ${r.candidate_name || 'Anonymous'}, ${r.submitted_at || new Date().toISOString()},
                ${JSON.stringify(answers)}::jsonb, ${typeof r.overall_score === 'number' ? r.overall_score : null})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      nSubs += s.length;
    }
  }

  const ttsDir = path.join(OLD, 'tts-cache');
  if (fs.existsSync(ttsDir)) {
    for (const f of fs.readdirSync(ttsDir).filter(f => f.endsWith('.pcm'))) {
      const p = `tts/${f}`;
      if (!(await blob.exists(p))) {
        await blob.write(p, fs.readFileSync(path.join(ttsDir, f)), 'application/octet-stream');
        nTts++;
      }
    }
  }

  console.log(`copied: ${nTests} tests, ${nSubs} submissions, ${nRec} recordings, ${nTts} speech files`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
