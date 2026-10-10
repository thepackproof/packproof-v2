'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const forge = require('node-forge');
const braces = require('braces');

// These exercise verification with mathematically valid RSA signatures around
// malformed DigestInfo objects, isolating the ASN.1 acceptance defect. They are
// not a claim to reproduce a private-key-free signature-forgery exploit.
const pem = crypto.generateKeyPairSync('rsa', {
  modulusLength: 1024, publicExponent: 3,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const privateKey = forge.pki.privateKeyFromPem(pem.privateKey);
const publicKey = forge.pki.publicKeyFromPem(pem.publicKey);
const asn = forge.asn1;
const node = (type, value, constructed = false) => asn.create(asn.Class.UNIVERSAL, type, constructed, value);
const nullNode = () => node(asn.Type.NULL, '');
const extra = () => node(asn.Type.OCTETSTRING, 'unexpected');
function encodedDigest(algorithm, digest, parameters) {
  return asn.toDer(node(asn.Type.SEQUENCE, [
    node(asn.Type.SEQUENCE, [node(asn.Type.OID, asn.oidToDer(forge.pki.oids[algorithm]).getBytes()), ...parameters], true),
    node(asn.Type.OCTETSTRING, digest),
  ], true)).getBytes();
}
function signedDigest(algorithm, parameters) {
  const md = forge.md[algorithm].create();
  md.update('PackProof dependency regression fixture', 'utf8');
  const digest = md.digest().getBytes();
  return { digest, signature: privateKey.sign(encodedDigest(algorithm, digest, parameters), 'NONE') };
}

for (const [name, parameters] of [
  ['extra child after NULL', [nullNode(), extra()]],
  ['extra children without NULL', [extra(), extra()]],
  ['substituted non-NULL parameter', [extra()]],
  ['nonempty NULL parameter', [node(asn.Type.NULL, 'invalid')]],
]) {
  test(`RSA rejects ${name}`, () => {
    const { digest, signature } = signedDigest('sha256', parameters);
    assert.throws(() => publicKey.verify(digest, signature), /ASN\.1 object does not contain a valid .*DigestInfo/);
  });
}
test('RSA retains supported SHA signatures with empty or omitted NULL', () => {
  for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512']) {
    for (const parameters of [[], [nullNode()]]) {
      const { digest, signature } = signedDigest(algorithm, parameters);
      assert.equal(publicKey.verify(digest, signature), true, algorithm);
      const wrongDigest = String.fromCharCode(digest.charCodeAt(0) ^ 1) + digest.slice(1);
      assert.equal(publicKey.verify(wrongDigest, signature), false, `${algorithm} wrong digest`);
    }
  }
});
test('RSA retains MD5 required-NULL rule and rejects tampering', () => {
  const valid = signedDigest('md5', [nullNode()]);
  assert.equal(publicKey.verify(valid.digest, valid.signature), true);
  const absent = signedDigest('md5', []);
  assert.throws(() => publicKey.verify(absent.digest, absent.signature), /NULL parameters/);
  const tampered = String.fromCharCode(valid.signature.charCodeAt(0) ^ 1) + valid.signature.slice(1);
  let accepted = false;
  try { accepted = publicKey.verify(valid.digest, tampered); } catch { /* rejection */ }
  assert.equal(accepted, false);
});
test('Forge certificate creation, PEM round trip, and verification still work', () => {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  const attributes = [{ name: 'commonName', value: 'dependency-test.invalid' }];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.sign(privateKey, forge.md.sha256.create());
  const roundTrip = forge.pki.certificateFromPem(forge.pki.certificateToPem(cert));
  assert.equal(roundTrip.verify(roundTrip), true);
});

const boundedError = error => error instanceof SyntaxError && /nesting depth/.test(error.message);
for (const [name, pattern] of [
  ['balanced braces', '{'.repeat(3500) + 'a,b' + '}'.repeat(3500)],
  ['balanced parentheses', '('.repeat(3500) + 'x' + ')'.repeat(3500)],
  ['unclosed braces', '{'.repeat(3500)],
  ['unclosed parentheses', '('.repeat(3500)],
  ['mixed nesting', '{('.repeat(1800) + 'x' + ')}'.repeat(1800)],
]) {
  test(`Braces rejects ${name} before recursive work`, () => {
    for (const operation of ['parse', 'compile', 'expand']) {
      assert.throws(() => braces[operation](pattern), boundedError, operation);
    }
  });
}
function deepAst() {
  const root = { type: 'root', nodes: [] };
  let current = root;
  for (let index = 0; index < 3500; index++) {
    const child = { type: 'paren', nodes: [], parent: current };
    current.nodes.push(child);
    current = child;
  }
  current.nodes.push({ type: 'text', value: 'x' });
  return root;
}
test('Braces raw AST and deep-import walker APIs cannot bypass the limit', () => {
  for (const name of ['compile', 'expand', 'stringify']) {
    assert.throws(() => braces[name](deepAst()), boundedError, name);
    const direct = require(`braces/lib/${name}`);
    assert.throws(() => direct(deepAst()), boundedError, `direct ${name}`);
  }
});
test('Braces rejects cyclic AST nodes without recursive stack exhaustion', () => {
  for (const name of ['compile', 'expand', 'stringify']) {
    const ast = { type: 'root', nodes: [] };
    ast.nodes.push(ast);
    assert.throws(() => braces[name](ast), boundedError, name);
  }
});
test('Braces accepts 128 structural levels and rejects the 129th', () => {
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const allowed = open.repeat(128) + 'x' + close.repeat(128);
    assert.doesNotThrow(() => braces.parse(allowed));
    assert.doesNotThrow(() => braces.compile(allowed));
    const rejected = open.repeat(129) + 'x' + close.repeat(129);
    assert.throws(() => braces.parse(rejected), boundedError);
    assert.throws(() => braces.compile(rejected), boundedError);
  }
});
test('Braces retains ordinary globs, ranges, escaped braces and quoted text', () => {
  assert.deepEqual(braces.expand('src/{one,two}/{a..c}.ts'), [
    'src/one/a.ts', 'src/one/b.ts', 'src/one/c.ts',
    'src/two/a.ts', 'src/two/b.ts', 'src/two/c.ts',
  ]);
  assert.equal(braces.compile('*.{js,ts}'), '*.(js|ts)');
  assert.equal(braces.stringify(braces.parse('x{a,b}')), 'x{a,b}');
  assert.deepEqual(braces.expand('"' + '{'.repeat(500) + '"'), ['{'.repeat(500)]);
  assert.deepEqual(braces.expand('\\{literal\\}'), ['{literal}']);
  assert.equal(braces.compile('('.repeat(127) + 'x' + ')'.repeat(127)).length, 255);
  assert.deepEqual(require('micromatch')(['a.ts', 'b.js', 'c.png'], '*.{js,ts}'), ['a.ts', 'b.js']);
});
