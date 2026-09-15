#!/usr/bin/env bash
set -euo pipefail

BUCKET="packproof-v2-staging-build-784514617543"
BASE_SHA="4ca7c91750668dd51c35068d507779f3c50d3ba7"
CURRENT_SHA="a5041731af99c09f9031c4e512b5742e78c8388e"
COMMON_BASE="18f7511fb121604d5db12805cfe2ab919eb482f3"
RELEASE_ROOT="s3://${BUCKET}/releases/cinematic-2026-09-10"

rm -rf /tmp/packproof-release /tmp/packproof-artifacts /tmp/base.bundle /tmp/delta.bundle /tmp/delta.b64
mkdir -p /tmp/packproof-artifacts
aws s3 cp "s3://${BUCKET}/releases/identifiers-2026-09-09/${BASE_SHA}/source.bundle" /tmp/base.bundle
git clone --branch fix/upload-recovery-20260909 /tmp/base.bundle /tmp/packproof-release
aws s3 cp "s3://${BUCKET}/releases/uploads-2026-09-10/${CURRENT_SHA}/source-delta.bundle.base64" /tmp/delta.b64
base64 --decode /tmp/delta.b64 > /tmp/delta.bundle
git -C /tmp/packproof-release fetch /tmp/delta.bundle refs/heads/codex/upload-notifications-usps:refs/heads/current-build44
git -C /tmp/packproof-release fetch https://github.com/thepackproof/packproof-v2.git codex/cinematic-motion-2026-09-10:refs/heads/cinematic

test "$(git -C /tmp/packproof-release rev-parse current-build44)" = "$CURRENT_SHA"
test "$(git -C /tmp/packproof-release merge-base current-build44 cinematic)" = "$COMMON_BASE"

git -C /tmp/packproof-release config user.name "PackProof Release"
git -C /tmp/packproof-release config user.email "release@thepackproof.com"
git -C /tmp/packproof-release checkout -B cinematic-current-build45 current-build44
git -C /tmp/packproof-release merge --no-commit --no-ff cinematic || true

mapfile -t conflicts < <(git -C /tmp/packproof-release diff --name-only --diff-filter=U | sort)
expected=("mobile/app.config.js" "mobile/src/ui/NativeCaptureHost.tsx")
if [[ "${conflicts[*]}" != "${expected[*]}" ]]; then
  printf 'Unexpected merge conflicts:\n%s\n' "${conflicts[*]}" >&2
  exit 1
fi

# Do not carry the branch-only GitHub signing workflow into the composed release source.
git -C /tmp/packproof-release checkout current-build44 -- .github/workflows/android-aab.yml 2>/dev/null || true
# Preserve build 44's upload/identifier camera pipeline and exact native release config.
git -C /tmp/packproof-release checkout --ours mobile/src/ui/NativeCaptureHost.tsx mobile/app.config.js

python3 - <<'PY'
from pathlib import Path
r = Path('/tmp/packproof-release')
p = r / 'mobile/src/ui/NativeCaptureHost.tsx'
s = p.read_text()
old = 'import { haptic } from "../theme/haptics";'
assert old in s
s = s.replace(old, old + '\nimport { cinematicForScheme } from "../theme/cinematic";', 1)
old = '  const { colors, reducedMotion } = useTheme();'
assert old in s
s = s.replace(old, '  const { colors, scheme, reducedMotion } = useTheme();\n  const accents = cinematicForScheme(scheme);', 1)
old = 'borderColor:scanFeedback.conflict ? colors.warning : colors.primary'
assert old in s
s = s.replace(old, 'borderColor:scanFeedback.conflict ? accents.amber : accents.teal', 1)
old = 'color={scanFeedback.conflict ? colors.warning : colors.primary}'
assert old in s
s = s.replace(old, 'color={scanFeedback.conflict ? accents.amber : accents.teal}', 1)
old = 'camera: { flex: 1, minHeight: 200, backgroundColor: "#23262D" }'
assert old in s
s = s.replace(old, 'camera: { flex: 1, minHeight: 200, backgroundColor: "#23262D", overflow: "hidden" }', 1)
p.write_text(s)

p = r / 'mobile/app.config.js'
s = p.read_text()
assert 'version: "0.3.15"' in s and 'versionCode: 44' in s
s = s.replace('version: "0.3.15"', 'version: "0.3.16"', 1)
s = s.replace('versionCode: 44', 'versionCode: 45', 1)
p.write_text(s)
PY

git -C /tmp/packproof-release add -A
git -C /tmp/packproof-release commit -m "Merge cinematic motion into current Android build"
export CANDIDATE_SHA="$(git -C /tmp/packproof-release rev-parse HEAD)"
echo "CANDIDATE_SHA=${CANDIDATE_SHA}"
test -z "$(git -C /tmp/packproof-release status --porcelain --untracked-files=no)"

cd /tmp/packproof-release/mobile
npm ci --no-audit --no-fund
npm run typecheck
npm run test:proof-record

cd /tmp/packproof-release
git bundle create /tmp/packproof-artifacts/source.bundle cinematic-current-build45
aws s3 cp /tmp/packproof-artifacts/source.bundle "${RELEASE_ROOT}/${CANDIDATE_SHA}/source.bundle" --sse AES256
printf '{"sourceSha":"%s","versionName":"0.3.16","versionCode":45}\n' "$CANDIDATE_SHA" > /tmp/packproof-artifacts/candidate.json
aws s3 cp /tmp/packproof-artifacts/candidate.json "${RELEASE_ROOT}/latest-candidate.json" --sse AES256 --content-type application/json

echo "PREPARED_SOURCE=${RELEASE_ROOT}/${CANDIDATE_SHA}/source.bundle"
