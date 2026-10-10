'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const forge = require('node-forge');
const expoSigning = require('@expo/code-signing-certificates');

test('PEM preserves standard message framing, multiple messages and folded headers', () => {
  const msg = {
    type: 'PRIVACY-ENHANCED MESSAGE', body: 'test\x00binary\xff',
    procType: { version: '4', type: 'ENCRYPTED' }, contentDomain: 'RFC822',
    dekInfo: { algorithm: 'AES-256-CBC', parameters: 'AABB' },
    headers: [{ name: 'Key-Info', values: ['one', 'two', 'x'.repeat(70)] }],
  };
  const encoded = forge.pem.encode(msg);
  assert.deepEqual(forge.pem.decode(encoded)[0], msg);
  assert.deepEqual(forge.pem.decode(encoded.replaceAll('\r\n', '\n'))[0], msg);
  assert.deepEqual(forge.pem.decode(Buffer.from(encoded))[0], msg);
  const simple = forge.pem.encode({ type: 'CERTIFICATE', body: 'abc' });
  assert.deepEqual(forge.pem.decode('preamble\n' + simple + simple).map(item => item.body), ['abc', 'abc']);
  assert.deepEqual(forge.pem.decode((simple + simple).replaceAll('\r\n', '\n')).map(item => item.body), ['abc', 'abc']);
  assert.equal(forge.pem.decode(simple.replace('-----\r\n', '-----'))[0].body, 'abc');
  assert.equal(forge.pem.decode(simple.replaceAll('\r\n', ''))[0].body, 'abc');
  assert.equal(forge.pem.decode('-----BEGIN DATA-----\nYW\n\nJj\n-----END DATA-----')[0].body, 'abc');
});

test('PEM retains literal boundary text inside ordinary and folded header values', () => {
  for (const value of ['note -----BEGIN INNER----- remains text', 'note\r\n -----BEGIN INNER----- remains text']) {
    const encoded = forge.pem.encode({ type: 'DATA', procType: { version: '4', type: 'MIC-ONLY' },
      headers: [{ name: 'Note', values: [value] }], body: 'abc' });
    const decoded = forge.pem.decode(encoded)[0];
    assert.equal(decoded.body, 'abc');
    assert.deepEqual(decoded.headers, [{ name: 'Note', values: ['note -----BEGIN INNER----- remains text'] }]);
  }
});

test('PEM requires matching original boundary labels before normalizing CSR alias', () => {
  const csr = '-----BEGIN NEW CERTIFICATE REQUEST-----\nYWJj\n-----END NEW CERTIFICATE REQUEST-----';
  assert.equal(forge.pem.decode(csr)[0].type, 'CERTIFICATE REQUEST');
  assert.throws(() => forge.pem.decode(csr.replace('END NEW CERTIFICATE REQUEST', 'END CERTIFICATE REQUEST')), /Invalid PEM/);
  assert.throws(() => forge.pem.decode('-----BEGIN CERTIFICATE-----\nYWJj\n-----END PRIVATE KEY-----'), /Invalid PEM/);
  assert.throws(() => forge.pem.decode('-----BEGIN DATA\n-----\nYWJj\n-----END DATA\n-----'), /Invalid PEM/);
  assert.throws(() => forge.pem.decode('-----BEGIN DATA-----\n@#$\n-----END DATA-----'), /Invalid PEM/);
  assert.throws(() => forge.pem.decode('-----BEGIN DATA-----\nOther: first\n\nYWJj\n-----END DATA-----'), /first encapsulated header/);
  const later = '-----BEGIN DATA-----\nYWJj\n-----END DATA-----';
  assert.deepEqual(forge.pem.decode('-----BEGIN BROKEN-----\nmissing end\n' + later).map(item => item.body), ['abc']);
});

test('PEM and actual Expo signing consumer retain certificates, CSRs and encrypted-key round trips', () => {
  const generated = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const pair = expoSigning.convertKeyPairPEMToKeyPair({ privateKeyPEM: generated.privateKey, publicKeyPEM: generated.publicKey });
  const roundTripPair = expoSigning.convertKeyPairPEMToKeyPair(expoSigning.convertKeyPairToPEM(pair));
  assert.equal(roundTripPair.privateKey.n.toString(16), pair.privateKey.n.toString(16));
  const cert = expoSigning.generateSelfSignedCodeSigningCertificate({ keyPair: pair,
    validityNotBefore: new Date(Date.now() - 86400000), validityNotAfter: new Date(Date.now() + 86400000),
    commonName: 'dependency-fixture.invalid' });
  const decoded = expoSigning.convertCertificatePEMToCertificate(expoSigning.convertCertificateToCertificatePEM(cert));
  expoSigning.validateSelfSignedCertificate(decoded, roundTripPair);
  assert.ok(expoSigning.signBufferRSASHA256AndVerify(roundTripPair.privateKey, decoded, Buffer.from('local fixture')));
  const csr = expoSigning.generateCSR(pair, 'dependency-fixture.invalid');
  assert.equal(expoSigning.convertCSRPEMToCSR(expoSigning.convertCSRToCSRPEM(csr)).verify(), true);
  for (const legacy of [false, true]) {
    const encrypted = forge.pki.encryptRsaPrivateKey(pair.privateKey, 'ephemeral-test-passphrase', { algorithm: 'aes256', legacy });
    const decrypted = forge.pki.decryptRsaPrivateKey(encrypted, 'ephemeral-test-passphrase');
    assert.equal(decrypted.n.toString(16), pair.privateKey.n.toString(16));
    // Legacy password encryption can reject wrong passwords at padding or at
    // ASN.1 parsing, depending on the random ciphertext; neither yields a key.
    let wrongPasswordKey = null;
    try { wrongPasswordKey = forge.pki.decryptRsaPrivateKey(encrypted, 'incorrect-test-passphrase'); } catch { /* rejected */ }
    assert.equal(wrongPasswordKey, null);
  }
});

// Each attack runs in a bounded subprocess so a future ReDoS regression cannot
// hang the suite. There is generous process-start margin; patched parsing takes
// milliseconds. Fixtures target each former CodeQL regex path plus repeated
// missing/mismatched boundaries, not merely a new input-size limit.
for (const attack of ['whitespace', 'missing-end', 'mismatched-end', 'header-whitespace', 'header-no-colon']) {
  test(`PEM processes adversarial ${attack} without polynomial backtracking`, () => {
    const program = `
      const pem = require(${JSON.stringify(require.resolve('node-forge/lib/pem'))});
      const attack = ${JSON.stringify(attack)};
      let input;
      if (attack === 'whitespace') input = ' '.repeat(200000);
      if (attack === 'missing-end') input = '-----BEGIN DATA-----\\nYWJj\\n'.repeat(8000);
      if (attack === 'mismatched-end') input = '-----BEGIN DATA-----\\nYWJj\\n-----END OTHER-----\\n'.repeat(8000);
      if (attack === 'header-whitespace') input = '-----BEGIN DATA-----\\nProc-Type: 4,ENCRYPTED\\nX: a' + ' '.repeat(200000) + '!\\n\\nYWJj\\n-----END DATA-----';
      if (attack === 'header-no-colon') input = '-----BEGIN DATA-----\\nProc-Type: 4,ENCRYPTED\\n' + 'A'.repeat(200000) + '\\n\\nYWJj\\n-----END DATA-----';
      try { pem.decode(input); } catch (error) { if (!/Invalid PEM/.test(error.message)) throw error; }
      process.stdout.write('bounded');
    `;
    const child = spawnSync(process.execPath, ['-e', program], { timeout: 5000, encoding: 'utf8', windowsHide: true });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'bounded');
  });
}
