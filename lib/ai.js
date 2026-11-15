// OpenAI calls: question generation, scoring, Whisper, text-to-speech.
const crypto = require('crypto');

const SCORING_MODEL = process.env.SCORING_MODEL || 'gpt-4o-mini';
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_VOICE = process.env.TTS_VOICE || 'alloy';

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY is not set');
  return k;
}

async function openaiJson(prompt, temperature) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({
      model: SCORING_MODEL,
      response_format: { type: 'json_object' },
      temperature,
      messages: [
        { role: 'system', content: 'You output strict JSON only. No prose, no markdown.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

function generateQuestions({ role, topics, count, difficulty }) {
  const prompt = `You are designing a voice-administered test for "${role}".
A small device reads each question aloud through a speaker and records the student's spoken answer.

Generate exactly ${count} questions at "${difficulty || 'intermediate'}" level.${topics ? `\nFocus areas: ${topics}.` : ''}

Rules:
- Questions must be answerable verbally in 1 to 3 minutes.
- Avoid questions that require writing or reading code.
- Keep each question under 200 characters so it fits on a small screen.
- Mix conceptual and scenario-based questions.

Respond with strict JSON in this exact shape:
{
  "questions": [
    { "text": "...", "time_limit_seconds": 120, "expected_topics": ["..."] }
  ]
}`;
  return openaiJson(prompt, 0.7);
}

async function scoreOneAnswer({ role, question, transcript }) {
  const prompt = `You score interview answers. Be strict but fair.

ROLE: ${role || 'unspecified'}
QUESTION: ${question}

CANDIDATE'S SPOKEN ANSWER (verbatim transcript, may contain disfluencies):
"""${transcript || '(no answer recorded)'}"""

Score 0 to 10:
- 0-2: empty, incorrect, off-topic
- 3-5: surface-level, missing depth or specifics
- 6-7: solid, mostly correct, fair detail
- 8-10: specific, structured, senior-caliber

If the transcript is empty/near-silent, score 0.

Return strict JSON: {"score": <integer 0-10>, "feedback": "<one specific sentence, 25 words max, addressing what was good or missing>"}`;
  const parsed = await openaiJson(prompt, 0.2);
  return {
    score: Number.isFinite(parsed.score) ? Math.max(0, Math.min(10, Math.round(parsed.score))) : null,
    feedback: String(parsed.feedback || '').slice(0, 300),
  };
}

async function transcribeWav(wav) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'answer.wav');
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Whisper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return String((await r.json()).text || '').trim();
}

// Raw PCM, 24 kHz, 16-bit signed, mono.
async function ttsPcm(text) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: 'pcm' }),
  });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

// Same hash as the old Mac server, so its cached audio can be reused.
function ttsPath(text) {
  const hash = crypto.createHash('sha1').update(`${TTS_VOICE}|${text}`).digest('hex');
  return `tts/${hash}.pcm`;
}

function speechText(test, key) {
  const n = test.questions.length;
  if (key === 'welcome') {
    return `Welcome. This is the ${test.role || test.title} test. I will ask you ${n} question${n === 1 ? '' : 's'}. ` +
      'After each question, start speaking after the beep. Press Enter when you finish your answer. Let us begin.';
  }
  if (key === 'end') return 'Thank you. Your answers have been submitted. Please call the next student.';
  const m = /^q(\d+)$/.exec(key);
  if (m) {
    const idx = Number(m[1]) - 1;
    const q = test.questions[idx];
    if (q) return `Question ${idx + 1}. ${q.text}`;
  }
  return null;
}

function speechKeys(test) {
  return ['welcome', ...test.questions.map((_, i) => `q${i + 1}`), 'end'];
}

module.exports = { generateQuestions, scoreOneAnswer, transcribeWav, ttsPcm, ttsPath, speechText, speechKeys };
