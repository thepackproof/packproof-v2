import { configurePolicyDurability } from "../domain/policy-recovery.js";
import { loadConfig,loadEnvFile } from '../config.js';
import { openDatabase } from './open.js';
import { migrate } from './migrate.js';
loadEnvFile();
const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:process.env.PACKPROOF_MIGRATION_DATABASE_URL??process.env.DATABASE_URL};
if(['production','staging'].includes(env.PACKPROOF_ENVIRONMENT??'')&&!env.PACKPROOF_MIGRATION_ROLE)throw new Error('Hosted migrations require PACKPROOF_MIGRATION_ROLE and separate migration credentials');
const opened=await openDatabase(loadConfig(env),env);
try{await migrate(opened.db);await configurePolicyDurability(opened.db,{required:loadConfig(env).requireDurableReceipts===true});console.log(JSON.stringify({event:'migrations_verified'}));}finally{await opened.close();}
