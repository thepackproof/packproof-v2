#!/usr/bin/env bash
set -euo pipefail

BUCKET="packproof-v2-staging-build-784514617543"
BASE_SHA="4ca7c91750668dd51c35068d507779f3c50d3ba7"
CURRENT_SHA="a5041731af99c09f9031c4e512b5742e78c8388e"
COMMON_BASE="18f7511fb121604d5db12805cfe2ab919eb482f3"
RELEASE_NAME="0.3.16"
VERSION_CODE="45"
EXPECTED_SIGNER_SHA256="95:FE:CD:E5:A5:5A:47:36:43:C8:C7:C8:12:E6:94:7F:CB:2A:77:9E:12:28:FD:35:AC:18:C1:39:6F:06:11:5E"
BASE_BUNDLE="s3://${BUCKET}/releases/identifiers-2026-09-09/${BASE_SHA}/source.bundle"
DELTA_B64="s3://${BUCKET}/releases/uploads-2026-09-10/${CURRENT_SHA}/source-delta.bundle.base64"
RELEASE_ROOT="s3://${BUCKET}/releases/cinematic-2026-09-10"

rm -rf /tmp/packproof-release /tmp/packproof-artifacts /tmp/packproof-source.bundle /tmp/source-delta.bundle /tmp/source-delta.bundle.base64
mkdir -p /tmp/packproof-artifacts

aws s3 cp "$BASE_BUNDLE" /tmp/packproof-source.bundle
git clone --branch fix/upload-recovery-20260909 /tmp/packproof-source.bundle /tmp/packproof-release
aws s3 cp "$DELTA_B64" /tmp/source-delta.bundle.base64
base64 --decode /tmp/source-delta.bundle.base64 > /tmp/source-delta.bundle
git -C /tmp/packproof-release bundle verify /tmp/source-delta.bundle
git -C /tmp/packproof-release fetch /tmp/source-delta.bundle refs/heads/codex/upload-notifications-usps:refs/heads/current-build44
git -C /tmp/packproof-release fetch https://github.com/thepackproof/packproof-v2.git codex/cinematic-motion-2026-09-10:refs/heads/cinematic

test "$(git -C /tmp/packproof-release rev-parse current-build44)" = "$CURRENT_SHA"
test "$(git -C /tmp/packproof-release merge-base current-build44 cinematic)" = "$COMMON_BASE"

git -C /tmp/packproof-release checkout -B cinematic-current-build45 current-build44
git -C /tmp/packproof-release merge --no-commit --no-ff cinematic || true

mapfile -t conflicts < <(git -C /tmp/packproof-release diff --name-only --diff-filter=U | sort)
expected=(
  "mobile/app.config.js"
  "mobile/src/screens/MyProofsScreen.tsx"
  "mobile/src/ui/NativeCaptureHost.tsx"
)
if [[ "${conflicts[*]}" != "${expected[*]}" ]]; then
  printf 'Unexpected merge conflicts:\n%s\n' "${conflicts[*]}" >&2
  exit 1
fi

# Keep the current release workflow configuration; this build is composed and signed in AWS/EAS.
git -C /tmp/packproof-release checkout current-build44 -- .github/workflows/android-aab.yml 2>/dev/null || true

# Keep the cinematic Proof list surface, but splice in build 44's current background-upload state derivation.
git -C /tmp/packproof-release checkout --theirs mobile/src/screens/MyProofsScreen.tsx
# Keep build 44's current camera/identifier pipeline and release config; enhance them below without regressing functionality.
git -C /tmp/packproof-release checkout --ours mobile/src/ui/NativeCaptureHost.tsx mobile/app.config.js

python3 - <<'PY'
from pathlib import Path
import subprocess

repo = "/tmp/packproof-release"

path = "mobile/src/screens/MyProofsScreen.tsx"
p = Path(repo, path)
merged = p.read_text()
current = subprocess.check_output(["git", "-C", repo, "show", f"current-build44:{path}"], text=True)
start = "  const presentedRows = useMemo("
end = "  const sortedRows = selectProofRows"
ms = merged.index(start)
me = merged.index(end, ms)
cs = current.index(start)
ce = current.index(end, cs)
p.write_text(merged[:ms] + current[cs:ce] + merged[me:])

p = Path(repo, "mobile/src/ui/NativeCaptureHost.tsx")
s = p.read_text()
old = 'import { haptic } from "../theme/haptics";'
assert old in s
s = s.replace(old, old + '\nimport { cinematicForScheme } from "../theme/cinematic";', 1)
old = "  const { colors, reducedMotion } = useTheme();"
assert old in s
s = s.replace(old, "  const { colors, scheme, reducedMotion } = useTheme();\n  const accents = cinematicForScheme(scheme);", 1)
old = "borderColor:scanFeedback.conflict ? colors.warning : colors.primary"
assert old in s
s = s.replace(old, "borderColor:scanFeedback.conflict ? accents.amber : accents.teal", 1)
old = "color={scanFeedback.conflict ? colors.warning : colors.primary}"
assert old in s
s = s.replace(old, "color={scanFeedback.conflict ? accents.amber : accents.teal}", 1)
old = 'camera: { flex: 1, minHeight: 200, backgroundColor: "#23262D" }'
assert old in s
s = s.replace(old, 'camera: { flex: 1, minHeight: 200, backgroundColor: "#23262D", overflow: "hidden" }', 1)
p.write_text(s)

p = Path(repo, "mobile/app.config.js")
s = p.read_text()
assert 'version: "0.3.15"' in s
assert "versionCode: 44" in s
s = s.replace('version: "0.3.15"', 'version: "0.3.16"', 1)
s = s.replace("versionCode: 44", "versionCode: 45", 1)
p.write_text(s)
PY

git -C /tmp/packproof-release add -A
git -C /tmp/packproof-release config user.name "PackProof Release"
git -C /tmp/packproof-release config user.email "release@thepackproof.com"
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

cd /tmp/packproof-release/mobile
eas env:set --name EXPO_PUBLIC_PACKPROOF_BUILD_SHA --value "$CANDIDATE_SHA" --environment production --visibility plaintext --non-interactive
eas build --platform android --profile shipping-integration --non-interactive --wait --json > /tmp/packproof-artifacts/eas-build.json

node - <<'NODE'
const fs = require('fs');
const payload = JSON.parse(fs.readFileSync('/tmp/packproof-artifacts/eas-build.json', 'utf8'));
const build = Array.isArray(payload) ? payload[0] : payload;
const url = build?.artifacts?.buildUrl || build?.artifactUrl;
if (build?.status !== 'FINISHED' || !url) throw new Error('EAS_SIGNED_BUILD_NOT_FINISHED');
fs.writeFileSync('/tmp/packproof-artifacts/aab-url.txt', url + '\n');
NODE

AAB="/tmp/packproof-artifacts/packproof-${RELEASE_NAME}-${VERSION_CODE}.aab"
curl --fail --location "$(cat /tmp/packproof-artifacts/aab-url.txt)" --output "$AAB"
jarsigner -verify "$AAB" > /tmp/packproof-artifacts/signature-verification.txt
grep -q 'jar verified' /tmp/packproof-artifacts/signature-verification.txt
curl --fail --location https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar --output /tmp/bundletool.jar
java -jar /tmp/bundletool.jar validate --bundle="$AAB" > /tmp/packproof-artifacts/bundletool-validation.txt
java -jar /tmp/bundletool.jar dump manifest --bundle="$AAB" --module=base > /tmp/packproof-artifacts/AndroidManifest.xml

python3 - <<'PY'
import hashlib, json, os, pathlib, re, subprocess, xml.etree.ElementTree as ET, zipfile
root = pathlib.Path('/tmp/packproof-artifacts')
aab = root / 'packproof-0.3.16-45.aab'
sha = os.environ['CANDIDATE_SHA']
ns = '{http://schemas.android.com/apk/res/android}'
manifest = ET.parse(root / 'AndroidManifest.xml').getroot()
app = manifest.find('application')
assert manifest.get('package') == 'com.packproof.mobile'
assert manifest.get(ns + 'versionName') == '0.3.16'
assert manifest.get(ns + 'versionCode') == '45'
services = {x.get(ns + 'name'): x for x in app.findall('service')}
service = services.get('com.packproof.unifiedcamera.UploadNotificationService')
assert service is not None
assert service.get(ns + 'exported') == 'false'
assert service.get(ns + 'foregroundServiceType') == 'dataSync'
permissions = {x.get(ns + 'name') for x in manifest.findall('uses-permission')}
assert {'android.permission.POST_NOTIFICATIONS','android.permission.FOREGROUND_SERVICE','android.permission.FOREGROUND_SERVICE_DATA_SYNC','android.permission.WAKE_LOCK'} <= permissions
assert app.get(ns + 'allowBackup') == 'false'
assert not app.get(ns + 'networkSecurityConfig')
cert = subprocess.check_output(['keytool','-printcert','-jarfile',str(aab)], text=True)
signer = re.search(r'SHA256:\s*([A-F0-9:]+)', cert).group(1)
assert signer == os.environ.get('EXPECTED_SIGNER_SHA256', '95:FE:CD:E5:A5:5A:47:36:43:C8:C7:C8:12:E6:94:7F:CB:2A:77:9E:12:28:FD:35:AC:18:C1:39:6F:06:11:5E')
with zipfile.ZipFile(aab) as archive:
    assert archive.testzip() is None
    names = archive.namelist()
    assert not any(n.endswith(('.jks','.keystore')) or pathlib.PurePosixPath(n).name in ['credentials.json','.env'] for n in names)
    bundle = archive.read('base/assets/index.android.bundle')
    assert sha.encode() in bundle
    assert b'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws' in bundle
    assert b'Proof completed' in bundle
    assert b'SECURE ATTESTATION' in bundle
result = {
    'artifact': aab.name,
    'sourceSha': sha,
    'bytes': aab.stat().st_size,
    'sha256': hashlib.sha256(aab.read_bytes()).hexdigest(),
    'package': manifest.get('package'),
    'versionName': '0.3.16',
    'versionCode': 45,
    'uploadSignerSha256': signer,
    'jarSignatureVerified': True,
    'bundletoolValidated': True,
    'backgroundUploadServiceVerified': True,
    'cinematicCopyVerified': True,
    'apiBaseUrlVerified': True,
    'sourceShaPackaged': True,
    'credentialsPackaged': False,
}
(root / 'verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
PY

aws s3 cp "$AAB" "${RELEASE_ROOT}/${CANDIDATE_SHA}/packproof-${RELEASE_NAME}-${VERSION_CODE}.aab" --sse AES256
aws s3 cp /tmp/packproof-artifacts/verification.json "${RELEASE_ROOT}/${CANDIDATE_SHA}/android-verification.json" --sse AES256 --content-type application/json
aws s3 cp /tmp/packproof-artifacts/eas-build.json "${RELEASE_ROOT}/${CANDIDATE_SHA}/eas-build.json" --sse AES256 --content-type application/json
aws s3 cp /tmp/packproof-artifacts/AndroidManifest.xml "${RELEASE_ROOT}/${CANDIDATE_SHA}/AndroidManifest.xml" --sse AES256 --content-type application/xml

echo "SIGNED_AAB_READY=${RELEASE_ROOT}/${CANDIDATE_SHA}/packproof-${RELEASE_NAME}-${VERSION_CODE}.aab"
