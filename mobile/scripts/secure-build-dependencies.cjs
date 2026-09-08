// Narrow, fail-closed compatibility/security patches for the pinned Expo 52 toolchain.
// These modify build tools only. Never suppress dependency audit findings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function patch(relative, expectedSha256, before, after) {
  const file = path.join(root, 'node_modules', relative);
  const source = fs.readFileSync(file, 'utf8');
  // Accept only the exact original or exact previously patched source.
  const original = source.includes(after) ? source.replace(after, before) : source;
  if (crypto.createHash('sha256').update(original).digest('hex') !== expectedSha256 || original.split(before).length !== 2)
    throw new Error(`Review the security patch before using changed dependency ${relative}.`);
  if (source !== original && source !== original.replace(before, after))
    throw new Error(`Unexpected dependency patch in ${relative}.`);
  fs.writeFileSync(file, original.replace(before, after));
}

// tar 7 exposes named CJS exports with __esModule:true. Expo 52's default-import
// helper otherwise resolves undefined; retain its two existing extraction APIs.
const tarImport = 'const data = /*#__PURE__*/ _interopRequireDefault(require("tar"));';
const tarCompat = 'const data = { default: require("tar") }; // PackProof: named tar 7 CommonJS exports';
patch('@expo/cli/build/src/utils/tar.js', '2f673a6bbba4ee208e478024c6ef4d73f727e7d9243356336bb69d80d53df7bb', tarImport, tarCompat);
patch('@expo/cli/build/src/utils/npm.js', '2883a0ca6fc57ad9234539cbbabe4418f571bc3a42d4b92b8f751dbe8c1edf29', tarImport, tarCompat);

// The pinned community-maintained legacy fork fixes GHSA-w3rx-r6r6-pgpr and
// GHSA-5p2g-fcmc-qvqq while preserving Metro's callable synchronous API. Refuse
// accidental reinstallation of the original package or an unreviewed fork version.
const imagePackage = require(path.join(root, 'node_modules/image-size/package.json'));
if (imagePackage.name !== 'image-size-next' || imagePackage.version !== '1.2.2')
  throw new Error('PackProof requires the reviewed image-size-next@1.2.2 dependency.');
// Keep the earlier format restriction as defense in depth. Reject signatures
// BEFORE detection, rather than relying on extensions or disableTypes().
// PackProof build assets use PNG; ISO-BMFF/AVIF/HEIF/JXL and ICNS are unsupported.
const imageLookup = 'function lookup(input, filepath) {\n';
const guardedLookup = imageLookup + `    // PackProof build asset security guard; inspect bytes, never file extensions.
    const prefix = Buffer.from(input.subarray(0, 12));
    const boxType = prefix.toString('ascii', 4, 8);
    if (prefix.toString('ascii', 0, 4) === 'icns' || boxType === 'JXL ' || boxType === 'ftyp') {
        throw new TypeError('PackProof build does not accept ICNS, JXL, or ISO-BMFF image assets; use PNG or JPEG.');
    }
`;
patch('image-size/dist/index.js', '28dbb0069d82ce0af3a94ad7ac7398f9d780943fab8817ff5388deec8d40c1ba', imageLookup, guardedLookup);
console.log('Verified and applied PackProof build dependency guards.');
