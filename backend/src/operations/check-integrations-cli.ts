import { loadEnvFile } from '../config.js';
import { integrationReadiness } from './integration-readiness.js';
loadEnvFile();
const report=integrationReadiness();
process.stdout.write(JSON.stringify(report,null,2)+'\n');
if(report.status==='BLOCKED')process.exitCode=2;
