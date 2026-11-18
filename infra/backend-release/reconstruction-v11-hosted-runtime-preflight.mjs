import {pathToFileURL} from 'node:url';
import {runHostedCollectorPreflight} from './reconstruction-v11-runtime-preflight.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHostedCollectorPreflight(process.argv[2]).then(receipt => console.log(JSON.stringify(receipt))).catch(error => {
    console.error(/^[A-Z0-9_]+$/.test(error?.message) ? error.message : 'HOSTED_COLLECTOR_PREFLIGHT_FAILED');
    process.exitCode = 1;
  });
}
