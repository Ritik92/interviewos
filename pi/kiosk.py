#!/usr/bin/env python3
"""InterviewOS Pi kiosk - USB keypad + USB mic + Bluetooth speaker + 1.3" OLED.

Flow: test code [Enter] -> roll number [Enter] -> welcome -> for each question:
speak it, beep, record (Enter = finish early) -> thank you.

Talks to the InterviewOS website (/api/device/*, X-Device-Token header).
Heavy work (text-to-speech, speech-to-text, AI scoring) happens on the website,
so the Pi needs no OpenAI key.

Resilience:
- Test text + question audio are downloaded once and cached on the SD card,
  so a test that was loaded before also works with no internet.
- Answers go into an on-disk outbox and are uploaded in the background,
  retrying until they succeed (survives Wi-Fi drops and reboots).
- Clear screen messages for: no Wi-Fi, no internet, website down, speaker off.
- If the Bluetooth speaker is off, audio falls back to the headphone jack / USB speaker.
- Pulls the latest code from GitHub when idle and restarts itself.

Keypad: digits, Enter = OK / finish answer, Backspace = delete,
        "-" (or Esc) on the roll-number screen = new test code.
Remote testing: echo "633663" > /tmp/kiosk-keys   (newline = Enter, "b" = Backspace, "x" = new test)
"""
import array
import hashlib
import json
import math
import os
import queue
import secrets
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import textwrap
import threading
import time
import wave

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("INTERVIEW_DATA_DIR", os.path.expanduser("~/interview-pi"))
CACHE_DIR = os.path.join(DATA_DIR, "cache")
OUTBOX_DIR = os.path.join(DATA_DIR, "outbox")

SERVERS = [s.strip().rstrip("/") for s in os.environ.get(
    "INTERVIEW_SERVER", "https://interviewos.vercel.app").split(",") if s.strip()]
TOKEN = os.environ.get("INTERVIEW_DEVICE_TOKEN", "").strip()
HOTSPOT_NAME = os.environ.get("INTERVIEW_HOTSPOT", "InterviewOS")
HOTSPOT_PASS = os.environ.get("INTERVIEW_HOTSPOT_PASS", "interview123")
LEAD_SILENCE = float(os.environ.get("INTERVIEW_LEAD_SILENCE", "0.6"))  # wakes BT speakers
BT_SPEAKER = os.environ.get("INTERVIEW_BT_SPEAKER", "").strip().upper()  # e.g. 2C:FD:B4:22:76:B3
AUTO_UPDATE = os.environ.get("INTERVIEW_AUTO_UPDATE", "1") != "0"
KEY_FIFO = "/tmp/kiosk-keys"
CHUNK = 3_000_000  # bytes per upload request (~94 s of 16 kHz audio); Vercel limit is ~4.5 MB


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def _git(*args, timeout=30):
    return subprocess.run(["git", "-C", HERE, *args], capture_output=True, text=True, timeout=timeout)


def _version():
    try:
        return _git("rev-parse", "--short", "HEAD", timeout=5).stdout.strip() or "dev"
    except Exception:
        return "dev"


VERSION = _version()
HEADERS = {"X-Device-Token": TOKEN, "X-Device-Version": VERSION, "User-Agent": f"InterviewOS-Pi/{VERSION}"}


# ---------------------------------------------------------------- screen
class Screen:
    def __init__(self):
        self.dev = None
        self.lock = threading.Lock()
        try:
            from luma.core.interface.serial import i2c
            from luma.oled.device import sh1106, ssd1306
            from PIL import ImageFont
            kind = os.environ.get("INTERVIEW_OLED", "sh1106")
            serial = i2c(port=1, address=int(os.environ.get("INTERVIEW_OLED_ADDR", "0x3C"), 16))
            self.dev = (ssd1306 if kind == "ssd1306" else sh1106)(serial)
            self.font = ImageFont.load_default()
            log("[oled] ready", kind)
        except Exception as exc:
            log("[oled] not available:", exc)

    def show(self, title, body="", footer=""):
        log(f"[screen] {title} | {body} | {footer}")
        if not self.dev:
            return
        from luma.core.render import canvas
        with self.lock:
            try:
                with canvas(self.dev) as d:
                    d.text((0, 0), title[:21], font=self.font, fill="white")
                    d.line((0, 12, 127, 12), fill="white")
                    for i, line in enumerate(textwrap.wrap(body, 21)[:3]):
                        d.text((0, 15 + i * 11), line, font=self.font, fill="white")
                    if footer:
                        d.text((0, 53), footer[:21], font=self.font, fill="white")
            except Exception as exc:
                log("[oled] draw failed:", exc)


# ---------------------------------------------------------------- keypad
DIGITS = {f"KEY_{n}": str(n) for n in range(10)}
DIGITS.update({f"KEY_KP{n}": str(n) for n in range(10)})
OK_KEYS = {"KEY_ENTER", "KEY_KPENTER"}
DEL_KEYS = {"KEY_BACKSPACE", "KEY_DELETE", "KEY_KPDOT"}
EXIT_KEYS = {"KEY_KPMINUS", "KEY_MINUS", "KEY_ESC"}


class Keypad:
    """Collects key presses from every keyboard-like input device + a FIFO."""

    def __init__(self):
        self.q = queue.Queue()
        threading.Thread(target=self._evdev_loop, daemon=True).start()
        threading.Thread(target=self._fifo_loop, daemon=True).start()

    def _evdev_loop(self):
        import evdev
        devices = {}
        while True:
            try:
                for path in evdev.list_devices():
                    if path in devices:
                        continue
                    dev = evdev.InputDevice(path)
                    keys = dev.capabilities().get(evdev.ecodes.EV_KEY, [])
                    if evdev.ecodes.KEY_KP1 in keys or evdev.ecodes.KEY_1 in keys:
                        devices[path] = dev
                        log("[keypad] using", dev.name)
                if not devices:
                    time.sleep(1)
                    continue
                r, _, _ = select.select(list(devices.values()), [], [], 1.0)
                for dev in r:
                    try:
                        for ev in dev.read():
                            if ev.type == evdev.ecodes.EV_KEY and ev.value == 1:  # key down
                                name = evdev.ecodes.KEY.get(ev.code)
                                name = name[0] if isinstance(name, list) else name
                                self._push(name)
                    except OSError:  # unplugged
                        log("[keypad] lost", dev.path)
                        devices.pop(dev.path, None)
            except Exception as exc:
                log("[keypad] error:", exc)
                time.sleep(1)

    def _fifo_loop(self):
        try:
            if os.path.exists(KEY_FIFO):
                os.remove(KEY_FIFO)
            os.mkfifo(KEY_FIFO, 0o666)
            os.chmod(KEY_FIFO, 0o666)
        except OSError as exc:
            log("[fifo] unavailable:", exc)
            return
        while True:
            with open(KEY_FIFO) as f:
                for ch in f.read():
                    if ch.isdigit():
                        self.q.put(ch)
                    elif ch == "\n":
                        self.q.put("OK")
                    elif ch == "b":
                        self.q.put("DEL")
                    elif ch == "x":
                        self.q.put("EXIT")

    def _push(self, name):
        if name in DIGITS:
            self.q.put(DIGITS[name])
        elif name in OK_KEYS:
            self.q.put("OK")
        elif name in DEL_KEYS:
            self.q.put("DEL")
        elif name in EXIT_KEYS:
            self.q.put("EXIT")

    def get(self, timeout=None):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None

    def clear(self):
        while not self.q.empty():
            self.q.get_nowait()


# ---------------------------------------------------------------- audio
AUDIO = {"bt": False}  # True while the Bluetooth speaker is connected and used


def bt_target():
    return "bluez_output." + BT_SPEAKER.replace(":", "_") + ".1"


def _wav_file(pcm: bytes, rate: int) -> str:
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(rate * LEAD_SILENCE) + pcm)
    tmp.close()
    return tmp.name


def speaker_connected():
    if not BT_SPEAKER:
        return False
    try:
        out = subprocess.run(["bluetoothctl", "info", BT_SPEAKER], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return False
    return "Connected: yes" in out


def ensure_speaker(screen=None, wait_s=25):
    """Reconnects the Bluetooth speaker if it dropped. Falls back to the
    headphone jack / USB speaker when it can't. Returns True if BT is used."""
    if not BT_SPEAKER:
        AUDIO["bt"] = False
        return False
    if speaker_connected():
        AUDIO["bt"] = True
        return True
    log("[speaker] not connected, reconnecting", BT_SPEAKER)
    if screen:
        screen.show("Speaker", "Connecting... make sure the speaker is ON", "")
    t0 = time.time()
    while time.time() - t0 < wait_s:
        subprocess.run(["bluetoothctl", "--timeout", "8", "connect", BT_SPEAKER], capture_output=True)
        if speaker_connected():
            time.sleep(2)  # let PipeWire create the speaker output
            log("[speaker] reconnected")
            AUDIO["bt"] = True
            return True
        time.sleep(1)
    log("[speaker] could not reconnect, using backup audio output")
    AUDIO["bt"] = False
    if screen:
        screen.show("Speaker is OFF", "Using backup audio (jack/USB). Turn on the speaker.", "")
        time.sleep(3)
    return False


def keep_speaker_awake():
    """Streams silence to the BT speaker so it never goes idle (some speakers drop the link)."""
    if not BT_SPEAKER:
        return
    zeros = b"\0" * 3200  # 0.1 s of 16 kHz mono 16-bit
    while True:
        if not speaker_connected():
            time.sleep(3)
            continue
        try:
            p = subprocess.Popen(["pw-cat", "--playback", "--raw", "--target", bt_target(), "--rate", "16000",
                                  "--channels", "1", "--format", "s16", "-"],
                                 stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
            while p.poll() is None:
                p.stdin.write(zeros)
                p.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        time.sleep(2)


def play_pcm(pcm: bytes, rate: int):
    path = _wav_file(pcm, rate)
    cmd = ["pw-play", path]
    if AUDIO["bt"]:
        cmd[1:1] = ["--target", bt_target()]
    try:
        subprocess.run(cmd, check=False, timeout=300)
    except FileNotFoundError:
        subprocess.run(["aplay", "-q", path], check=False, timeout=300)
    finally:
        os.unlink(path)


def tone(freq, ms, rate=24000, vol=0.5):
    n = int(rate * ms / 1000)
    a = array.array("h", (int(vol * 32767 * math.sin(2 * math.pi * freq * i / rate)) for i in range(n)))
    return a.tobytes()


def beep(freq, ms):
    play_pcm(tone(freq, ms), 24000)


def record(seconds, keypad, screen, header, footer):
    """Records 16 kHz mono 16-bit until the time limit or Enter. Returns raw PCM."""
    path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    cmd = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", path]
    try:
        proc = subprocess.Popen(cmd)
    except FileNotFoundError:
        proc = subprocess.Popen(["arecord", "-q", "-f", "S16_LE", "-r", "16000", "-c", "1", path])
    keypad.clear()
    start = time.time()
    while True:
        left = int(seconds - (time.time() - start))
        if left <= 0:
            break
        screen.show(header, f"Speak now... {left}s left", footer)
        k = keypad.get(timeout=1.0)
        if k == "OK":
            break
    proc.send_signal(signal.SIGINT)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    try:
        with wave.open(path, "rb") as w:
            pcm = w.readframes(w.getnframes())
    except Exception as exc:
        log("[rec] could not read recording:", exc)
        pcm = b""
    os.unlink(path)
    log(f"[rec] {len(pcm) / 32000:.1f}s recorded")
    return pcm


# ---------------------------------------------------------------- network
def wifi_connection():
    """Name of the connected Wi-Fi network, "" if not connected, None if unknown."""
    try:
        out = subprocess.run(["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "dev"],
                             capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split(":", 2)
            if parts[0] == "wlan0":
                return parts[2] if parts[1] == "connected" else ""
    except Exception:
        pass
    return None


def has_internet():
    for host in ("1.1.1.1", "8.8.8.8"):
        try:
            socket.create_connection((host, 53), timeout=3).close()
            return True
        except OSError:
            pass
    return False


PROBLEMS = {
    "nowifi": ("No WiFi", f"Turn on phone hotspot {HOTSPOT_NAME} pass {HOTSPOT_PASS}", "No WiFi!"),
    "nointernet": ("No internet", "WiFi is on but no internet. Turn on mobile data.", "No internet!"),
    "noserver": ("Website not reachable", "Check internet. Retrying...", "Website down!"),
    "badtoken": ("Device not allowed", "Device token is wrong. Ask Ritik to fix.", "Bad device token!"),
}


class Server:
    def __init__(self):
        self.base = None
        self.problem = "noserver"
        self.lock = threading.Lock()

    def find(self):
        with self.lock:
            bad_token = False
            for base in SERVERS:
                try:
                    r = requests.get(base + "/api/device/ping", headers=HEADERS, timeout=8)
                    if r.status_code == 401:
                        bad_token = True
                        continue
                    if r.text.strip() == "OK":
                        if base != self.base:
                            log("[server] using", base)
                        self.base, self.problem = base, None
                        return True
                except requests.RequestException:
                    pass
            self.base = None
            if bad_token:
                self.problem = "badtoken"
            elif wifi_connection() == "":
                self.problem = "nowifi"
            elif not has_internet():
                self.problem = "nointernet"
            else:
                self.problem = "noserver"
            return False

    def url(self, path):
        if not self.base and not self.find():
            raise requests.ConnectionError(self.problem or "offline")
        return self.base + path

    def get(self, path, **kw):
        return requests.get(self.url(path), headers=HEADERS, timeout=kw.pop("timeout", 20), **kw)

    def post(self, path, headers=None, **kw):
        return requests.post(self.url(path), headers={**HEADERS, **(headers or {})},
                             timeout=kw.pop("timeout", 30), **kw)


class Outbox:
    """On-disk queue of uploads. Jobs run strictly in order and are retried until done."""

    def __init__(self, server):
        os.makedirs(OUTBOX_DIR, exist_ok=True)
        self.server = server
        self.wake = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    def add(self, job, pcm=None):
        name = str(time.time_ns())
        if pcm is not None:
            with open(os.path.join(OUTBOX_DIR, name + ".pcm"), "wb") as f:
                f.write(pcm)
                f.flush()
                os.fsync(f.fileno())
        tmp = os.path.join(OUTBOX_DIR, name + ".tmp")
        with open(tmp, "w") as f:
            json.dump(job, f)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, os.path.join(OUTBOX_DIR, name + ".json"))
        self.wake.set()

    def pending(self):
        try:
            return sum(1 for f in os.listdir(OUTBOX_DIR) if f.endswith(".json"))
        except OSError:
            return 0

    def _remove(self, name):
        for ext in (".json", ".pcm"):
            try:
                os.remove(os.path.join(OUTBOX_DIR, name + ext))
            except FileNotFoundError:
                pass

    def _loop(self):
        delay = 2
        while True:
            try:
                jobs = sorted(f[:-5] for f in os.listdir(OUTBOX_DIR) if f.endswith(".json"))
            except OSError:
                jobs = []
            if not jobs:
                self.wake.wait(30)
                self.wake.clear()
                continue
            name = jobs[0]
            try:
                with open(os.path.join(OUTBOX_DIR, name + ".json")) as f:
                    job = json.load(f)
            except Exception as exc:
                log("[outbox] dropping unreadable job", name, exc)
                self._remove(name)
                continue
            try:
                done = self._send(job, name)
            except Exception as exc:
                log("[outbox]", job.get("type"), "failed:", exc)
                done = False
            if done:
                self._remove(name)
                delay = 2
                continue
            self.wake.wait(delay)
            self.wake.clear()
            delay = min(delay * 2, 60)

    def _send(self, job, name):
        t = job.get("type")
        if t == "session":
            r = self.server.post(f"/api/device/tests/{job['code']}/sessions",
                                 params={"roll": job["roll"], "sid": job["sid"], "live": "0"})
        elif t == "answer":
            with open(os.path.join(OUTBOX_DIR, name + ".pcm"), "rb") as f:
                pcm = f.read()
            parts = max(1, math.ceil(len(pcm) / CHUNK))
            r = None
            for i in range(parts):
                r = self.server.post(f"/api/device/sessions/{job['sid']}/answers/{job['qn']}",
                                     params={"part": i, "parts": parts},
                                     data=pcm[i * CHUNK:(i + 1) * CHUNK],
                                     headers={"Content-Type": "application/octet-stream"}, timeout=120)
                if not r.ok:
                    break
        elif t == "finish":
            r = self.server.post(f"/api/device/sessions/{job['sid']}/finish", params={"live": "0"})
        else:
            log("[outbox] unknown job", job)
            return True
        if r.ok:
            log(f"[outbox] {t} {job.get('sid')} {job.get('qn', '')} uploaded")
            return True
        if r.status_code in (400, 404):  # permanent: test deleted / bad request
            log(f"[outbox] {t} dropped: HTTP {r.status_code} {r.text[:80]}")
            return True
        log(f"[outbox] {t} HTTP {r.status_code}, will retry")
        return False


# ---------------------------------------------------------------- app
class TestNotFound(Exception):
    pass


class Offline(Exception):
    pass


class Kiosk:
    def __init__(self):
        self.screen = Screen()
        self.keys = Keypad()
        self.server = Server()
        self.outbox = Outbox(self.server)
        self.busy = False
        self.restart_pending = False
        self.code = ""
        self.title = ""
        self.questions = []  # (seconds, text)
        self.test_dir = ""

    # ---- background
    def heartbeat(self):
        last_update_check = 0
        while True:
            self.server.find()
            if AUTO_UPDATE and self.server.base and time.time() - last_update_check > 1800:
                last_update_check = time.time()
                self.check_update()
            time.sleep(15)

    def check_update(self):
        if self.busy or not os.path.isdir(os.path.join(HERE, "..", ".git")):
            return
        try:
            if _git("fetch", "--quiet", "origin", timeout=60).returncode != 0:
                return
            local = _git("rev-parse", "HEAD").stdout.strip()
            remote = _git("rev-parse", "@{u}").stdout.strip()
            if remote and local != remote:
                if _git("pull", "--ff-only", "--quiet", timeout=60).returncode == 0:
                    log("[update] new code pulled:", remote[:7])
                    self.restart_pending = True
        except Exception as exc:
            log("[update] failed:", exc)

    def progress(self, **params):
        code = self.code

        def go():
            if not self.server.base:
                return
            try:
                requests.post(f"{self.server.base}/api/device/tests/{code}/progress",
                              params=params, headers=HEADERS, timeout=6)
            except requests.RequestException:
                pass
        threading.Thread(target=go, daemon=True).start()

    # ---- screens
    def status_footer(self, default):
        if self.server.problem:
            return PROBLEMS[self.server.problem][2]
        n = self.outbox.pending()
        if n:
            return f"Uploading {n}..."
        return default

    def show_problem(self, seconds=4):
        title, body, _ = PROBLEMS.get(self.server.problem or "noserver")
        self.screen.show(title, body, "")
        time.sleep(seconds)

    def read_keys(self, header, footer, max_len, allow_exit=False):
        val = ""
        self.keys.clear()
        shown = (val, self.status_footer(footer))
        self.screen.show(header, val or "_", shown[1])
        while True:
            k = self.keys.get(timeout=3)
            if k is None:
                if self.restart_pending and not self.busy:
                    self.screen.show("Updating", "New version installed. Restarting...", "")
                    time.sleep(1)
                    os._exit(0)  # systemd restarts us with the new code
            elif k.isdigit() and len(val) < max_len:
                val += k
            elif k == "DEL":
                val = val[:-1]
            elif k == "OK" and val:
                return val
            elif k == "EXIT" and allow_exit:
                return ""
            now = (val, self.status_footer(footer))
            if now != shown:  # redraw only when something changed
                shown = now
                self.screen.show(header, val or "_", now[1])

    # ---- test + audio cache
    def load_test(self, code):
        text = None
        try:
            r = self.server.get(f"/api/device/tests/{code}")
            if r.status_code == 404:
                raise TestNotFound()
            if r.ok and r.text.startswith("OK|"):
                text = r.text
        except requests.RequestException:
            pass
        if text is None:
            text = self._cached_test_text(code)
            if text is None:
                raise Offline()
            log("[test] using cached copy of", code)
        lines = text.strip().splitlines()
        _, count, title = lines[0].split("|", 2)
        qs = []
        for line in lines[1:1 + int(count)]:
            _, secs, qtext = line.split("|", 2)
            qs.append((int(secs), qtext))
        digest = hashlib.sha1(text.encode()).hexdigest()[:10]
        self.test_dir = os.path.join(CACHE_DIR, f"{code}-{digest}")
        os.makedirs(self.test_dir, exist_ok=True)
        with open(os.path.join(self.test_dir, "test.txt"), "w") as f:
            f.write(text)
        self.code, self.title, self.questions = code, title, qs
        self._prune_cache()

    def _cached_test_text(self, code):
        best = None
        if os.path.isdir(CACHE_DIR):
            for d in os.listdir(CACHE_DIR):
                p = os.path.join(CACHE_DIR, d, "test.txt")
                if d.startswith(code + "-") and os.path.exists(p):
                    if best is None or os.path.getmtime(p) > os.path.getmtime(best):
                        best = p
        if best:
            with open(best) as f:
                return f.read()
        return None

    def _prune_cache(self, keep=15):
        try:
            dirs = sorted((os.path.join(CACHE_DIR, d) for d in os.listdir(CACHE_DIR)), key=os.path.getmtime)
            for d in dirs[:-keep]:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass

    def speech_keys(self):
        return ["welcome"] + [f"q{i}" for i in range(1, len(self.questions) + 1)] + ["end"]

    def fetch_audio(self, key):
        path = os.path.join(self.test_dir, f"{key}.pcm")
        if os.path.exists(path) and os.path.getsize(path) > 0:
            return path
        r = self.server.get(f"/api/device/tests/{self.code}/speech/{key}", timeout=60)
        if not (r.ok and r.content):
            raise RuntimeError(f"speech {key}: HTTP {r.status_code}")
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(r.content)
        os.rename(tmp, path)
        return path

    def prefetch_audio(self):
        keys = self.speech_keys()
        missing = 0
        for i, key in enumerate(keys, 1):
            self.screen.show(self.title[:21], f"Preparing audio {i}/{len(keys)}", "")
            try:
                self.fetch_audio(key)
            except Exception as exc:
                log("[audio]", key, exc)
                missing += 1
        return missing

    def speak(self, key, text_for_screen=""):
        try:
            path = self.fetch_audio(key)
            with open(path, "rb") as f:
                pcm = f.read()
        except Exception as exc:
            log("[speech]", key, exc)
            # No audio: give time to read the question on screen instead.
            time.sleep(min(12, 3 + len(text_for_screen) / 15))
            return False
        ensure_speaker(self.screen, wait_s=6)
        play_pcm(pcm, 24000)
        return True

    # ---- interview
    def interview(self, roll):
        n = len(self.questions)
        sid = secrets.token_hex(8)
        self.busy = True
        try:
            self.outbox.add({"type": "session", "code": self.code, "roll": roll, "sid": sid, "at": time.time()})
            self.progress(phase="welcome", roll=roll, total=n)
            ensure_speaker(self.screen, wait_s=20)
            self.screen.show(self.title[:21], "Welcome! Listen to the instructions.", f"Roll {roll}")
            self.speak("welcome", "Welcome")
            for i, (secs, text) in enumerate(self.questions, 1):
                self.screen.show(f"Q{i}/{n}  Listen...", text, f"Roll {roll}")
                self.progress(phase="speaking", q=i, total=n)
                self.speak(f"q{i}", text)
                beep(880, 180)
                self.progress(phase="listening", q=i, secs=secs, total=n)
                pcm = record(secs, self.keys, self.screen, f"Q{i}/{n}  Recording", "Enter = finish")
                self.outbox.add({"type": "answer", "sid": sid, "qn": i}, pcm)
                self.progress(phase="processing", q=i, total=n)
                beep(523, 120)
            self.outbox.add({"type": "finish", "sid": sid})
            self.progress(phase="complete")
            self.screen.show("All done", "Your answers are saved.", f"Roll {roll}")
            self.speak("end", "Thank you")
            self.screen.show("Thank you!", "Answers submitted. Next student please.", "")
            time.sleep(2.5)
        finally:
            self.busy = False

    def run(self):
        self.screen.show("InterviewOS", f"Starting... v{VERSION}", "")
        os.makedirs(CACHE_DIR, exist_ok=True)
        if not TOKEN:
            log("[config] INTERVIEW_DEVICE_TOKEN is not set")
        for _ in range(10):  # give Wi-Fi up to ~30 s after boot
            if self.server.find():
                break
            self.screen.show("Connecting...", PROBLEMS[self.server.problem][1], "")
            time.sleep(3)
        threading.Thread(target=self.heartbeat, daemon=True).start()
        ensure_speaker(self.screen)
        threading.Thread(target=keep_speaker_awake, daemon=True).start()
        self.screen.show("Ready", "Online" if self.server.base else "Offline: cached tests only", f"v{VERSION}")
        beep(1000, 100)
        while True:
            try:
                if not self.code:
                    code = self.read_keys("Enter test code", "Bksp=del Enter=OK", 6)
                    self.screen.show("Loading", f"Fetching test {code} ...", "")
                    try:
                        self.load_test(code)
                    except TestNotFound:
                        self.screen.show("Wrong code", f"Test {code} not found. Check the code.", "")
                        time.sleep(3)
                        continue
                    except Offline:
                        self.show_problem()
                        continue
                    missing = self.prefetch_audio()
                    note = f"{missing} audio missing" if missing else "Audio ready"
                    self.screen.show(self.title[:21], f"{len(self.questions)} questions loaded. {note}", "")
                    time.sleep(1.5)
                    continue
                roll = self.read_keys("Roll number", "Enter=start  -=new test", 10, allow_exit=True)
                if not roll:
                    self.code = ""
                    continue
                self.interview(roll)
            except Exception as exc:
                log("[error]", exc)
                self.screen.show("Error", str(exc)[:60], "")
                time.sleep(2.5)


if __name__ == "__main__":
    Kiosk().run()
