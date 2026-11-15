#!/bin/bash
# Save a Wi-Fi network on the Pi (NetworkManager):
#   bash add-wifi.sh "<name>" "<password>" [priority]
# Higher priority wins when several saved networks are in range.
set -euo pipefail
SSID="$1"; PASS="$2"; PRIO="${3:-10}"
sudo nmcli connection delete "$SSID" >/dev/null 2>&1 || true
sudo nmcli connection add type wifi ifname wlan0 con-name "$SSID" ssid "$SSID" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PASS" \
  connection.autoconnect yes connection.autoconnect-priority "$PRIO" >/dev/null
echo "saved Wi-Fi '$SSID' (priority $PRIO)"
