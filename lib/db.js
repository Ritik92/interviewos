// Postgres (Neon) over HTTP. Tables are created automatically on first use.
const { neon } = require('@neondatabase/serverless');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tests (
     code TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT '',
     duration_minutes INT NOT NULL DEFAULT 60,
     questions JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     test_code TEXT NOT NULL REFERENCES tests(code) ON DELETE CASCADE,
     candidate_name TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS answers (
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     qn INT NOT NULL,
     question_id INT NOT NULL,
     status TEXT NOT NULL,
     audio_path TEXT,
     transcript TEXT NOT NULL DEFAULT '',
     seconds REAL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (session_id, qn)
   )`,
  `CREATE TABLE IF NOT EXISTS submissions (
     id TEXT PRIMARY KEY,
     test_code TEXT NOT NULL REFERENCES tests(code) ON DELETE CASCADE,
     session_id TEXT UNIQUE,
     candidate_name TEXT NOT NULL,
     submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     answers JSONB NOT NULL,
     overall_score REAL
   )`,
  `CREATE INDEX IF NOT EXISTS submissions_test_code_idx ON submissions (test_code)`,
  `CREATE INDEX IF NOT EXISTS sessions_test_code_idx ON sessions (test_code)`,
];

let _sql = null;
function raw() {
  if (!_sql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    _sql = neon(url);
  }
  return _sql;
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    const sql = raw();
    schemaReady = sql.transaction(SCHEMA.map(s => sql.query(s))).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// Tagged template: await db`SELECT * FROM tests WHERE code = ${code}`  -> rows[]
async function db(strings, ...values) {
  await ensureSchema();
  return raw()(strings, ...values);
}

module.exports = { db, ensureSchema };
