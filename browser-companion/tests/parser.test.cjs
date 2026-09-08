const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../parser.js'), 'utf8');
const config = fs.readFileSync(require('node:path').join(__dirname, '../config.js'), 'utf8');
// Synthetic fixture, deliberately unrelated to undocumented live marketplace selectors.
const descriptor = { validated: true, fixtureDigest: 'synthetic-only', origin: 'https://fixture.invalid', pathPattern: '^/order$', locale: 'en-US', physicalFullOrder: true, paidStatuses: ['Paid'], selectors: { root: 'order', orderId: 'id', accountReference: 'seller', item: 'item', title: 'title', quantity: 'quantity', variant: 'variant', status: 'status' } };
function node(text, children = {}, visible = true) { return { textContent: text, hidden: false, getAttribute: () => null, getClientRects: () => visible ? [{}] : [], querySelectorAll: name => children[name] ?? [], querySelector: name => children[name]?.[0] ?? null }; }
function fixture({ qty = '2', duplicate = false, hidden = false, title = 'Card <script>alert(1)</script>' } = {}) {
  const item = node('', { title: [node(title)], quantity: [node(qty)], variant: [node('Foil')] }, !hidden);
  const root = node('', { id: [node('12-34567-89101')], status: [node('Paid')], item: [item, node('', { title: [node('Sleeve')], quantity: [node('1')] })] });
  const document = node('', { order: duplicate ? [root, root] : [root], seller: [node('seller-1')] }); document.documentElement = { lang: 'en-US' };
  const context = { document, location: { origin: 'https://fixture.invalid', pathname: '/order' } };
  vm.createContext(context); vm.runInContext(source, context); vm.runInContext(config, context);
  return context;
}
test('production adapter fails closed before any page scraping until an actual fixture is validated', () => {
  const ctx = fixture(); ctx.document.querySelectorAll = () => { throw Error('must not inspect'); };
  assert.equal(ctx.PackProofPageParser.extractPage(ctx.PACKPROOF_BROWSER_ADAPTER).reason, 'PAGE_ADAPTER_NOT_VALIDATED');
});
test('synthetic complete multi-item fixture preserves data as plain strings', () => {
  const result = fixture().PackProofPageParser.extractPage(descriptor);
  assert.equal(result.ok, true); assert.equal(result.observation.items.length, 2); assert.equal(result.observation.items[0].quantity, 2);
  assert.equal(result.observation.items[0].variant, 'Foil'); assert.match(result.sourceExcerpt, /<script>/);
});
test('unknown quantities, hidden lines, multiple selected orders and wrong origins fail closed', () => {
  for (const options of [{ qty: '' }, { qty: '2 boxes' }, { hidden: true }, { duplicate: true }, { title: 'x'.repeat(1001) }]) assert.equal(fixture(options).PackProofPageParser.extractPage(descriptor).ok, false);
  const foreign = fixture(); foreign.location.origin = 'https://attacker.example'; assert.equal(foreign.PackProofPageParser.extractPage(descriptor).reason, 'UNSUPPORTED_PAGE');
});
