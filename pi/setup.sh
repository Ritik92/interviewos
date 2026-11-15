#!/bin/bash
# One-time setup on a fresh Raspberry Pi (Raspberry Pi OS Lite 64-bit, Trixie). Run as user pi:
#   curl -fsSL https://raw.githubusercontent.com/Ritik92/interviewos/main/pi/setup.sh | bash
# Then put the device token in ~/interview-pi/.env and reboot.
set -euo pipefail
REPO_URL=${REPO_URL:-https://github.com/Ritik92/interviewos.git}
DIR="$HOME/interview-pi"
APP="$DIR/app"

sudo apt-get update
sudo apt-get install -y git \
  pipewire pipewire-pulse pipewire-alsa pipewire-bin wireplumber libspa-0.2-bluetooth \
  bluez python3-evdev python3-requests python3-pil python3-venv i2c-tools
sudo raspi-config nonint do_i2c 0 || true

mkdir -p "$DIR"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO_URL" "$APP"; fi

# luma.oled is not packaged; keep it in a venv that can still see the apt packages.
[ -x "$DIR/venv/bin/python" ] || python3 -m venv --system-site-packages "$DIR/venv"
"$DIR/venv/bin/pip" install --quiet luma.oled

[ -f "$DIR/.env" ] || cp "$APP/pi/env.example" "$DIR/.env"

# Bluetooth audio on a headless Pi.
mkdir -p ~/.config/wireplumber/wireplumber.conf.d
cp "$APP"/pi/wireplumber/*.conf ~/.config/wireplumber/wireplumber.conf.d/

# The phone hotspot friends will use.
bash "$APP/pi/add-wifi.sh" "${HOTSPOT:-InterviewOS}" "${HOTSPOT_PASS:-interview123}" 20

# Audio runs in the pi user's session; linger keeps it running without a login.
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now pipewire pipewire-pulse wireplumber

mkdir -p ~/.config/systemd/user
cp "$APP/pi/interview-kiosk.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable interview-kiosk
systemctl --user restart interview-kiosk
echo "setup done. Edit $DIR/.env (device token, speaker MAC) and reboot."
