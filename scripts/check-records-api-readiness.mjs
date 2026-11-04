import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let ts;
try { ts = require(path.join(root, 'backend/node_modules/typescript')); }
catch { console.error('Install the backend development dependencies before checking the source contract.'); process.exit(1); }
const api = JSON.parse(fs.readFileSync(path.join(root, 'backend/partner-openapi.json'), 'utf8'));
const failures = [];
const parse = relative => {
  const filename = path.join(root, relative);
  return ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
};
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
const walk = (node, fn) => { fn(node); ts.forEachChild(node, child => walk(child, fn)); };
const mounted = (source, receiver, factory, prefix) => {
  let found = false;
  walk(source, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.expression.getText(source) !== receiver || node.expression.name.text !== 'use') return;
    if (prefix !== null && literal(node.arguments[0]) !== prefix) return;
    for (const argument of node.arguments) if (ts.isCallExpression(argument) && argument.expression.getText(source) === factory) found = true;
  });
  return found;
};
const app = parse('backend/src/app.ts');
const platform = parse('backend/src/platform/router.ts');
const partner = parse('backend/src/platform/partner-router.ts');
const modules = [
  ['backend/src/records/router.ts', 'createRecordsRouter', '/me/records', app, 'app', '/me/records'],
  ['backend/src/records/router.ts', 'createPartnerRecordsRouter', '/v1/partner', partner, 'router', null],
  ['backend/src/records/imports-router.ts', 'createRecordImportsRouter', '/me/records/imports', app, 'app', '/me/records/imports'],
  ['backend/src/records/connections-router.ts', 'createRecordConnectionsRouter', '/me/records/connections', app, 'app', '/me/records/connections'],
  ['backend/src/records/media-router.ts', 'createRecordMediaRouter', '/me/records', app, 'app', '/me/records'],
  ['backend/src/records/workspace-requests.ts', 'createWorkspaceRequestsRouter', '/me/records/workspace-requests', app, 'app', '/me/records/workspace-requests'],
];
const optionalOperations = 'backend/src/records/partner-operations-router.ts';
if (fs.existsSync(path.join(root, optionalOperations))) modules.push([optionalOperations, 'createPartnerOperationsRouter', '/v1/partner', partner, 'router', null]);
const sourceIngestions = 'backend/src/records/ingestions-router.ts';
if (fs.existsSync(path.join(root, sourceIngestions))) modules.push([sourceIngestions, 'createPartnerIngestionsRouter', '/v1/partner', partner, 'router', null]);
if (!mounted(app, 'app', 'createPlatformRouter', '/v1') || !mounted(platform, 'router', 'createPartnerRouter', '/partner')) failures.push('Partner parent route is not mounted at /v1/partner');

const actual = new Set();
for (const [relative, factory, prefix, parent, receiver, mount] of modules) {
  if (!mounted(parent, receiver, factory, mount)) failures.push(`${factory} is not mounted at its expected parent`);
  const source = parse(relative);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === factory);
  if (!declaration?.body) { failures.push(`${factory} function not found in ${relative}`); continue; }
  walk(declaration.body, node => {
    if (!ts.isCallExpression(node)) return;
    let method = null, route = null;
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === 'router') {
      method = node.expression.name.text;
      route = literal(node.arguments[0]);
    } else if (ts.isIdentifier(node.expression) && ['command', 'endpoint'].includes(node.expression.text)) {
      method = literal(node.arguments[0]);
      route = literal(node.arguments[1]);
    } else if (ts.isIdentifier(node.expression) && node.expression.text === 'read') {
      method = 'get'; route = literal(node.arguments[0]);
    }
    if (!['get', 'post', 'patch', 'put', 'delete'].includes(method) || route === null) return;
    const fullPath = (prefix + (route === '/' ? '' : route)).replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, '{$1}');
    actual.add(`${method.toUpperCase()} ${fullPath}`);
  });
}

const described = new Set();
const operationIds = new Set();
for (const [route, item] of Object.entries(api.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!operation || typeof operation !== 'object' || !operation.operationId) continue;
    if (operationIds.has(operation.operationId)) failures.push(`Duplicate operationId ${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (!operation['x-packproof-generated-records']) continue;
    const key = `${method.toUpperCase()} ${route}`;
    described.add(key);
    for (const match of route.matchAll(/\{([^}]+)\}/g)) {
      if (!operation.parameters?.some(parameter => parameter.in === 'path' && parameter.name === match[1] && parameter.required === true)) failures.push(`${key} lacks required path parameter ${match[1]}`);
    }
    if (!operation.security?.length) failures.push(`${key} has no documented authentication`);
    if (operation.requestBody && !Object.keys(operation.requestBody.content ?? {}).length) failures.push(`${key} has an empty request body contract`);
  }
}
for (const route of actual) if (!described.has(route)) failures.push(`Runtime route missing from generated contract: ${route}`);
for (const route of described) if (!actual.has(route)) failures.push(`Generated route missing from runtime: ${route}`);

walkJson(api, value => {
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return;
  const resolved = value.$ref.slice(2).split('/').reduce((current, key) => current?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], api);
  if (resolved === undefined) failures.push(`Unresolved reference ${value.$ref}`);
});
function walkJson(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walkJson(child, visit);
}

const generated = spawnSync(process.execPath, [path.join(root, 'scripts/generate-records-openapi.mjs'), '--check'], { cwd: root, encoding: 'utf8' });
if (generated.status !== 0) failures.push(generated.stderr.trim() || 'Generated OpenAPI is stale');
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else console.log(JSON.stringify({ status: 'passed', documentedRuntimeRecordOperations: actual.size, totalOpenApiOperations: operationIds.size, scope: 'Static source mounts, routes, parameters, authentication declarations, references and generated-contract freshness. Production activation, runtime behavior and external release gates require their own evidence.' }));
