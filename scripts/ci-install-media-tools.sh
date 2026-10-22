#!/usr/bin/env bash
# Ephemeral Ubuntu CI only. Use signed official archives instead of the runner's
# intermittently stalled Azure mirror. Never relax APT signature verification.
set -euo pipefail
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  . /etc/os-release
  test "$ID" = ubuntu
  [[ "$VERSION_CODENAME" =~ ^[a-z]+$ ]]
  sources="$(mktemp "${RUNNER_TEMP:-/tmp}/packproof-apt-XXXXXX.sources")"
  trap 'rm -f -- "$sources"' EXIT
  cat > "$sources" <<EOF
Types: deb
URIs: https://archive.ubuntu.com/ubuntu
Suites: $VERSION_CODENAME ${VERSION_CODENAME}-updates
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://security.ubuntu.com/ubuntu
Suites: ${VERSION_CODENAME}-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  options=(-o "Dir::Etc::sourcelist=$sources" -o Dir::Etc::sourceparts=-
    -o APT::Get::List-Cleanup=0 -o Acquire::Retries=2
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30
    -o DPkg::Lock::Timeout=30)
  timeout --kill-after=10s 180s sudo apt-get "${options[@]}" update
  timeout --kill-after=10s 300s sudo apt-get "${options[@]}" install -y --no-install-recommends ffmpeg
fi
ffmpeg -version
ffprobe -version
