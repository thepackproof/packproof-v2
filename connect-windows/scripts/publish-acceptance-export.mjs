// Publish synthetic input to a dedicated test folder. This helper has no network
// calls and cannot grant access, import a file, or declare a host qualified.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const phases = ['first', 'ui-closed', 'after-reboot', 'offline'];
const sourceHeaders = 'Shipment reference,Description,Quantity,Shipment date';

export async function publishExport(parent, run, phase) {
  if (!parent || !/^[a-zA-Z0-9-]{1,40}$/.test(run) || !phases.includes(phase)) {
    throw Error('Supply the test parent folder, a run ID (letters, digits, hyphens), and first, ui-closed, after-reboot, or offline.');
  }
  const directory = join(resolve(parent), 'packproof-acceptance-' + run);
  if (phase === 'first') await mkdir(directory);
  if (!(await lstat(directory)).isDirectory()) throw Error('Choose the dedicated test directory created in the first step.');
  const file = join(directory, phase + '.csv');
  const expected = {
    shipmentReference: `QA-${run}-${phase}`,
    itemTitle: 'Synthetic acceptance shipment ' + phase,
    quantity: phases.indexOf(phase) + 1,
    shippedAt: new Date().toISOString()
  };
  // An exclusive marker prevents repeated operator attempts from manufacturing
  // additional exports for the same step. Only completed CSVs become visible.
  const marker = file + '.json';
  const temp = file + '.' + randomUUID() + '.pending';
  const csv = sourceHeaders + '\r\n' + Object.values(expected).join(',') + '\r\n';
  const sha256 = createHash('sha256').update(csv).digest('hex');
  await writeFile(marker, JSON.stringify({ file:basename(file), ...expected, sha256 }, null, 2), { flag:'wx' });
  await writeFile(temp, csv, { flag:'wx' });
  await rename(temp, file);
  return { file, sha256, expected };
}

export async function checkReceipt(csvPath, receiptPath, proofPath) {
  const bytes = await readFile(csvPath);
  const source = JSON.parse(await readFile(csvPath + '.json','utf8'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const receipt = JSON.parse(await readFile(receiptPath,'utf8'));
  const { proof } = JSON.parse(await readFile(proofPath,'utf8'));
  const [row] = receipt.rows ?? [];
  const counts = receipt.counts;
  if (!receipt.id || receipt.state !== 'succeeded' || source.file !== basename(csvPath) ||
      source.sha256 !== digest || receipt.original?.sha256 !== digest || counts?.imported !== 1 ||
      ['duplicate','valid','invalid','ambiguous','failed'].some(key => counts[key] !== 0) ||
      receipt.rows?.length !== 1 || row?.status !== 'imported' || row.rowNumber !== 2 ||
      !row.proofId || receipt.recordIds?.length !== 1 || receipt.recordIds[0] !== row.proofId ||
      proof?.proofId !== row.proofId || !row.payloadSha256) {
    throw Error('The original, completed import, row outcomes, and canonical Proof do not reconcile.');
  }
  const normalized = row.normalized ?? {};
  if (normalized.shipmentReference !== source.shipmentReference || normalized.itemTitle !== source.itemTitle ||
      normalized.quantity !== source.quantity || normalized.shippedAt !== source.shippedAt ||
      proof.transaction?.itemTitle !== source.itemTitle || proof.transaction?.quantity !== source.quantity ||
      !proof.events?.some(event => event.eventType === 'SERVICE_CSV_SHIPMENT_IMPORTED' &&
        event.data?.originalSha256 === digest && event.data?.importId === receipt.id && event.data?.rowNumber === 2 &&
        event.data?.payloadSha256 === row.payloadSha256 && event.data?.sourceReportedAt === source.shippedAt)) {
    throw Error('The retrieved Proof lacks the exact expected values or original import event.');
  }
  return { result:'matched', file:basename(csvPath), digest, receiptId:receipt.id, proofId:proof.proofId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode,...args] = process.argv.slice(2);
    if (!['publish','check'].includes(mode) || args.length !== 3) throw Error('Use publish <parent> <run-id> <phase>, or check <fixture.csv> <receipt.json> <proof.json>.');
    console.log(JSON.stringify(await (mode === 'publish' ? publishExport(...args) : checkReceipt(...args)), null, 2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
