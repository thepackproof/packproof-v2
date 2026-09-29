#!/usr/bin/env bash
set -euo pipefail
APP_PATH="$1"
mkdir -p dist/store-screenshots
xcrun simctl list devices available --json > dist/store-screenshots/simulator-devices.json
DEVICE_ID=$(python3 - <<'PY'
import json
j=json.load(open('dist/store-screenshots/simulator-devices.json'))
for name in ['iPhone 17 Pro Max','iPhone 16 Pro Max','iPhone 15 Pro Max']:
 for runtime,devices in sorted(j['devices'].items(),reverse=True):
  for d in devices:
   if d['name']==name:
    print(d['udid']);raise SystemExit
raise SystemExit('No supported 6.9-inch screenshot device is installed')
PY
)
xcrun simctl boot "$DEVICE_ID"
xcrun simctl bootstatus "$DEVICE_ID" -b
xcrun simctl status_bar "$DEVICE_ID" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
xcrun simctl install "$DEVICE_ID" "$APP_PATH"
xcrun simctl launch "$DEVICE_ID" com.packproof.mobile
APP_DATA=$(xcrun simctl get_app_container "$DEVICE_ID" com.packproof.mobile data)
mkdir -p "$APP_DATA/Documents"
sleep 5
for specification in '01-proof-library:library:light' '02-new-proof:create:light' '03-shipment-tracking:tracking:light' '04-proof-activity:activity:light' '05-proof-library-dark:library:dark'; do
 IFS=: read -r name scene theme <<< "$specification"
 printf '{"scene":"%s","theme":"%s"}' "$scene" "$theme" > "$APP_DATA/Documents/store-scene.tmp"
 mv "$APP_DATA/Documents/store-scene.tmp" "$APP_DATA/Documents/store-scene.json"
 ready=0
 for attempt in $(seq 1 40); do
  if [ -f "$APP_DATA/Documents/store-scene-ready.txt" ] && [ "$(cat "$APP_DATA/Documents/store-scene-ready.txt")" = "$scene:$theme" ]; then ready=1; break; fi
  sleep 1
 done
 test "$ready" = 1 || { echo "Screenshot scene did not become ready: $scene"; exit 1; }
 xcrun simctl io "$DEVICE_ID" screenshot --type=jpeg "dist/store-screenshots/$name.jpg"
 sips -g pixelWidth -g pixelHeight "dist/store-screenshots/$name.jpg"
done
printf '%s\n' "$GITHUB_SHA" > dist/store-screenshots/source-commit.txt
xcrun simctl spawn "$DEVICE_ID" log show --last 3m --predicate 'process == "PackProof"' --style compact > dist/store-screenshots/simulator.log || true

python3 - <<'PYVERIFY'
from pathlib import Path
import hashlib
files=list(Path('dist/store-screenshots').glob('*.jpg'))
assert len(files)==5
assert len({hashlib.sha256(p.read_bytes()).hexdigest() for p in files})==5, 'Capture did not move through five different native screens'
PYVERIFY
