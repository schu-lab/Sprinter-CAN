#!/usr/bin/env bash
set -euo pipefail

DOWNLOAD_URL="https://www.kvaser.com/downloads-kvaser/?utm_source=software&utm_ean=7330130980754&utm_status=latest"
WORK_DIR="$(mktemp -d -t sprinter-kvaser-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Sprinter CAN — Kvaser LinuxCAN setup"
echo "This one-time setup compiles Kvaser's driver for kernel $(uname -r)."
echo

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This helper only runs on Raspberry Pi OS / Linux." >&2
  exit 1
fi

if ldconfig -p 2>/dev/null | grep -q 'libcanlib\.so'; then
  echo "Kvaser CANlib is already installed."
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "apt-get was not found. Follow Kvaser's LinuxCAN instructions manually." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  build-essential \
  dkms \
  pkg-config \
  raspberrypi-kernel-headers \
  wget

cd "$WORK_DIR"
wget --content-disposition "$DOWNLOAD_URL"
ARCHIVE="$(find . -maxdepth 1 -type f -name '*.tar.gz' -print -quit)"
if [[ -z "$ARCHIVE" ]]; then
  echo "Kvaser's LinuxCAN archive was not downloaded." >&2
  exit 1
fi

tar -xzf "$ARCHIVE"
LINUXCAN_DIR="$(find . -maxdepth 2 -type d -name linuxcan -print -quit)"
if [[ -z "$LINUXCAN_DIR" ]]; then
  echo "The downloaded archive did not contain a linuxcan directory." >&2
  exit 1
fi

cd "$LINUXCAN_DIR"
make dkms
sudo make dkms_install
sudo ldconfig

echo
echo "Kvaser LinuxCAN is installed. Reboot the Pi, reconnect the U100, and open Sprinter CAN."
