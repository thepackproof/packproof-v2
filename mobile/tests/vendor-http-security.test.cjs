'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const http = require('node-forge/lib/http');
const forge = require('node-forge/lib/forge');

function client(options = {}) {
  return http.createClient({
    url: 'http://packproof.invalid',
    persistCookies: false,
    socketPool: {
      flashApi: null,
      createSocket: () => ({
        id: 'offline-fixture',
        isConnected: () => false,
        // Exercise request construction without any network transport.
        connect() {},
        close() {},
        destroy() {},
      }),
    },
    ...options,
  });
}

function cookie(name, path = '/', value = 'fixture-value') {
  return { name, path, value, secure: false, maxAge: -1 };
}

function withStorage(initial, run) {
  const original = {
    getItem: forge.util.getItem,
    setItem: forge.util.setItem,
    clearItems: forge.util.clearItems,
  };
  let stored = initial;
  let saves = 0;
  forge.util.getItem = () => stored;
  forge.util.setItem = (_api, _id, _key, value) => {
    // Match persistence's ordinary JSON objects, including own __proto__ keys.
    stored = JSON.parse(JSON.stringify(value));
    saves += 1;
  };
  forge.util.clearItems = () => { stored = null; };
  try {
    run(() => ({ stored, saves }));
  } finally {
    Object.assign(forge.util, original);
  }
}

test('cookie names and paths cannot read, delete, or write inherited properties', () => {
  const c = client();
  const originalConstructor = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor');
  const probe = '__packproof_cookie_regression__';
  const originalProbe = Object.getOwnPropertyDescriptor(Object.prototype, probe);
  try {
    assert.equal(c.getCookie('__proto__', 'constructor'), null);
    assert.equal(c.removeCookie('__proto__', 'constructor'), false);
    assert.equal(c.setCookie(cookie('__proto__', probe)), true);
    assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, probe), originalProbe);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'), originalConstructor);
    assert.equal(c.getCookie('__proto__', probe).value, 'fixture-value');
    for (const name of ['__proto__', 'constructor', 'toString', 'prototype']) {
      for (const path of ['/', '__proto__', 'constructor', 'toString']) {
        assert.equal(c.setCookie(cookie(name, path)), true);
        assert.equal(c.getCookie(name, path).name, name);
        assert.equal(c.getCookie(name, path).path, path);
        assert.equal(c.removeCookie(name, path), true);
        assert.equal(c.getCookie(name, path), null);
      }
    }
    assert.equal(Object.getPrototypeOf(c.cookies), null);
  } finally {
    // Keep a failing vulnerable-control run isolated from later tests.
    Object.defineProperty(Object.prototype, 'constructor', originalConstructor);
    if (originalProbe) Object.defineProperty(Object.prototype, probe, originalProbe);
    else delete Object.prototype[probe];
    c.destroy();
  }
});

test('persistence reload, save, removal and clearing preserve safe dictionaries and valid cookies', () => {
  const seed = Object.create(null);
  seed.__proto__ = Object.create(null);
  seed.__proto__.__proto__ = cookie('__proto__', '__proto__', 'persisted');
  seed.session = { '/': cookie('session', '/', 'ordinary') };
  withStorage(JSON.parse(JSON.stringify(seed)), state => {
    const c = client({ persistCookies: true });
    try {
      assert.equal(c.getCookie('__proto__', '__proto__').value, 'persisted');
      assert.equal(c.getCookie('session').value, 'ordinary');
      assert.equal(Object.getPrototypeOf(c.cookies), null);
      assert.equal(Object.getPrototypeOf(c.cookies.__proto__), null);
      c.setCookie(cookie('constructor', '__proto__', 'saved'));
      assert.equal(state().saves, 1);
      assert.equal(c.getCookie('constructor', '__proto__').value, 'saved');
      assert.equal(Object.getPrototypeOf(c.cookies.constructor), null);
      assert.equal(c.removeCookie('__proto__', '__proto__'), true);
      assert.equal(c.getCookie('__proto__'), null);
      c.clearCookies();
      assert.equal(state().stored, null);
      assert.equal(Object.getPrototypeOf(c.cookies), null);
      c.setCookie(cookie('__proto__', '/', 'after-clear'));
      assert.equal(c.getCookie('__proto__', '/').value, 'after-clear');
      assert.equal(c.removeCookie('__proto__'), true);
      assert.equal(c.getCookie('__proto__'), null);
    } finally {
      c.destroy();
    }
  });
});

test('persistent loading ignores inherited entries and malformed dictionary values', () => {
  const inheritedPaths = { '/': cookie('inherited') };
  const source = Object.create({ inherited: inheritedPaths });
  source.valid = Object.create({ '/ignored': cookie('valid', '/ignored') });
  source.valid['/'] = cookie('valid');
  source.nullValue = null;
  source.arrayValue = [];
  source.scalarValue = 'invalid';
  source.badCookie = { '/': null };
  withStorage(source, () => {
    const c = client({ persistCookies: true });
    try {
      assert.equal(c.getCookie('inherited'), null);
      assert.equal(c.getCookie('valid', '/ignored'), null);
      assert.equal(c.getCookie('valid', '/').value, 'fixture-value');
      assert.equal(c.getCookie('badCookie'), null);
      assert.equal(c.getCookie('nullValue'), null);
      assert.equal(c.getCookie('arrayValue'), null);
      assert.equal(c.getCookie('scalarValue'), null);
    } finally {
      c.destroy();
    }
  });
});

test('ordinary cookie path, expiry, replacement, domain and secure checks remain intact', () => {
  const c = client();
  try {
    c.setCookie(cookie('session', '/', 'old'));
    c.setCookie(cookie('session', '/', 'new'));
    c.setCookie(cookie('account', '/account', 'scoped'));
    c.setCookie(cookie('elsewhere', '/other', 'not-sent'));
    const expired = cookie('expired');
    c.setCookie(expired);
    expired.created = 0;
    expired.maxAge = 1;
    assert.throws(() => c.setCookie({ ...cookie('secure'), secure: true }));
    assert.throws(() => c.setCookie({ ...cookie('domain'), domain: '.other.invalid' }));
    const request = http.createRequest({ method: 'GET', path: '/account/settings' });
    c.send({ request });
    assert.equal(request.getField('Cookie'), 'session=new; account=scoped');
    assert.equal(c.getCookie('expired'), null);
    assert.equal(c.setCookie(cookie('session', '/', '')), true);
    assert.equal(c.getCookie('session'), null);
  } finally {
    c.destroy();
  }
});

test('outgoing requests ignore inherited cookie names and paths', () => {
  const c = client();
  try {
    c.setCookie(cookie('own', '/', 'kept'));
    Object.setPrototypeOf(c.cookies, { inherited: { '/': cookie('inherited') } });
    Object.setPrototypeOf(c.cookies.own, { '/account': cookie('inherited-path', '/account') });
    const request = http.createRequest({ method: 'GET', path: '/account' });
    c.send({ request });
    assert.equal(request.getField('Cookie'), 'own=kept');
    assert.equal(c.getCookie('own', '/account'), null);
    assert.equal(c.removeCookie('own', '/account'), false);
  } finally {
    c.destroy();
  }
});

test('HTTP whitespace trimming preserves header semantics on ordinary values', () => {
  const request = http.createRequest({ method: 'GET', path: '/' });
  request.setField('X-Fixture', ' \t\u00a0value\uFEFF ');
  request.appendField('X-Fixture', '\r\nsecond\t ');
  assert.equal(request.getField('X-Fixture'), 'value');
  assert.equal(request.getField('X-Fixture', 1), 'second');
  request.setField('X-Empty', '\t '.repeat(1000));
  assert.equal(request.getField('X-Empty'), '');
});

test('adversarial interior whitespace completes through the HTTP API within a bounded child process', () => {
  const program = `
    const assert = require('node:assert/strict');
    const http = require(${JSON.stringify(require.resolve('node-forge/lib/http'))});
    const request = http.createRequest({ method: 'GET', path: '/' });
    const value = 'a' + ' '.repeat(200000) + 'b';
    request.setField('X-Long', value);
    assert.equal(request.getField('X-Long'), value);
  `;
  const result = spawnSync(process.execPath, ['-e', program], { timeout: 5000, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
