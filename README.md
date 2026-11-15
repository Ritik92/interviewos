# InterviewOS

AI-powered voice interview and candidate evaluation system (Thapar University capstone, team CPG104).

A Raspberry Pi kiosk speaks each question, records the spoken answer and uploads it.
The website transcribes answers (Whisper), scores them with AI, and shows results.

- **Website:** https://interviewos-cpg104.vercel.app
- **Device:** Raspberry Pi 4 + USB keypad + USB mic + Bluetooth speaker + 1.3" OLED

## How it works

```
 Pi kiosk ──(test code, roll no.)──▶ website /api/device/*  ──▶ Neon Postgres (tests, results)
   ▲  speaks questions (cached TTS)                         ──▶ Vercel Blob (recordings, audio)
   └─ records answers ─▶ on-disk outbox ─▶ upload (retries)  ──▶ OpenAI (TTS, Whisper, scoring)
```

| Part | Where |
|---|---|
| `server.js`, `lib/` | Express app on Vercel: dashboard API + device API |
| `public/` | Dashboard (login, create test, results, live screen) |
| `pi/kiosk.py` | The device program (systemd user service on the Pi) |
| `pi/setup.sh` | One-time Pi setup |
| `scripts/` | DB init, old-data migration, end-to-end smoke test |

## Website

Environment variables (Vercel project settings): `OPENAI_API_KEY`, `DATABASE_URL` (Neon),
`BLOB_READ_WRITE_TOKEN` (private Blob store), `ADMIN_USER`, `ADMIN_PASSWORD`,
`SESSION_SECRET`, `DEVICE_TOKEN`.

```bash
npm install
vercel env pull .env.local
npm run db:init            # create tables (also happens automatically)
npm start                  # http://localhost:5173
node scripts/smoke-test.js https://interviewos-cpg104.vercel.app some-answer.wav
```

Pushing to `main` deploys to production.

## Device API

All requests send `X-Device-Token`.

| Method | Path | |
|---|---|---|
| GET | `/api/device/ping` | `OK` |
| GET | `/api/device/tests/:code` | `OK\|count\|title` then `n\|seconds\|text` lines |
| POST | `/api/device/tests/:code/sessions?roll=&sid=` | start an attempt (Pi may choose `sid`) |
| GET | `/api/device/tests/:code/speech/:key` | `welcome`, `q1..qN`, `end`: raw PCM 24 kHz s16 mono |
| POST | `/api/device/tests/:code/progress?phase=&q=&secs=` | live status for the dashboard |
| POST | `/api/device/sessions/:sid/answers/:n?part=&parts=` | raw PCM 16 kHz s16 mono, ≤3 MB per part |
| POST | `/api/device/sessions/:sid/finish` | transcripts are awaited, then AI scoring |

## Raspberry Pi

```bash
curl -fsSL https://raw.githubusercontent.com/Ritik92/interviewos/main/pi/setup.sh | bash
nano ~/interview-pi/.env      # INTERVIEW_DEVICE_TOKEN, INTERVIEW_BT_SPEAKER
sudo reboot
```

The kiosk pulls new code from GitHub when idle and on every restart.
Logs: `journalctl --user -u interview-kiosk -f`.
