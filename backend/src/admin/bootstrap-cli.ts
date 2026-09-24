import { loadConfig,loadEnvFile } from '../config.js';
import { openDatabase } from '../db/open.js';
import { assertSchemaCurrent } from '../db/migrate.js';
import { systemClock } from '../clock.js';
import { bootstrapSystemAdmin } from './bootstrap.js';
loadEnvFile();
const userId=process.env.PACKPROOF_ADMIN_BOOTSTRAP_USER_ID?.trim();
const cognitoSubject=process.env.PACKPROOF_ADMIN_BOOTSTRAP_COGNITO_SUB?.trim();
const reason=process.env.PACKPROOF_ADMIN_BOOTSTRAP_REASON?.trim();
if(!userId||!cognitoSubject||!reason)throw new Error('Set PACKPROOF_ADMIN_BOOTSTRAP_USER_ID, PACKPROOF_ADMIN_BOOTSTRAP_COGNITO_SUB and PACKPROOF_ADMIN_BOOTSTRAP_REASON. The account must already have a verified Cognito contact.');
const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:process.env.PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL??process.env.DATABASE_URL};
// An explicitly selected operator URL must not inherit the runtime secret's
// password provider (and thereby authenticate as the wrong database role).
if(process.env.PACKPROOF_ADMIN_BOOTSTRAP_DATABASE_URL) {
  delete env.PACKPROOF_DB_SECRET_ARN;
  if(process.env.PACKPROOF_ADMIN_BOOTSTRAP_DB_SECRET_ARN) env.PACKPROOF_DB_SECRET_ARN=process.env.PACKPROOF_ADMIN_BOOTSTRAP_DB_SECRET_ARN;
}
const opened=await openDatabase(loadConfig(env),env);
try { await assertSchemaCurrent(opened.db); const result=await bootstrapSystemAdmin(opened.db,systemClock,{userId,cognitoSubject,reason}); console.log(JSON.stringify({event:'system_admin_bootstrap',...result})); }
finally { await opened.close(); }
