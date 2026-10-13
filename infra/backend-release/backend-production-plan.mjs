/** Explicit in-place promotion; existing customer resources and credentials stay bound. */
import { makePlan, hash } from './backend-deployment-plan.mjs';

export function makeProductionPlan(snapshot, candidate, { taskCount = 1 } = {}) {
  if (![1, 2].includes(taskCount)) throw Error('REVIEWED_TASK_COUNT_REQUIRED');
  const plan = makePlan(snapshot, candidate);
  const config = snapshot.express.activeConfigurations[0];
  const original = config.primaryContainer;
  const env = Object.fromEntries(original.environment.map(x => [x.name, x.value]));
  if (!['staging','production'].includes(env.PACKPROOF_ENVIRONMENT)
    || snapshot.meta.environment !== env.PACKPROOF_ENVIRONMENT) throw Error('ENVIRONMENT_IDENTITY_MISMATCH');
  if (env.PACKPROOF_AUTH_MODE !== 'cognito' || env.PACKPROOF_OBJECT_STORAGE !== 's3'
    || env.PACKPROOF_CREDENTIAL_STORE !== 'secrets-manager' || env.NODE_ENV !== 'production'
    || env.PACKPROOF_MIGRATE_ON_START !== 'false' || env.PACKPROOF_MANIFEST_SIGNING_MODE !== 'kms'
    || env.PACKPROOF_MANIFEST_SIGNING_REQUIRED !== 'true') throw Error('MANAGED_PRODUCTION_DEPENDENCIES_REQUIRED');
  const namespace = env.PACKPROOF_CREDENTIAL_NAMESPACE || env.PACKPROOF_ENVIRONMENT;
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(namespace)) throw Error('INVALID_EXISTING_CREDENTIAL_NAMESPACE');
  const changes = { PACKPROOF_ENVIRONMENT: 'production', PACKPROOF_CREDENTIAL_NAMESPACE: namespace, PACKPROOF_DB_SSLMODE: 'verify-full' };
  const container = plan.update.primaryContainer;
  for (const [name,value] of Object.entries(changes)) {
    const existing = container.environment.find(x => x.name === name);
    if (existing) existing.value = value;
    else container.environment.push({name,value});
  }
  plan.update.healthCheckPath = '/ready';
  plan.update.scalingTarget = {...config.scalingTarget, minTaskCount: taskCount, maxTaskCount: taskCount};
  plan.rollback.healthCheckPath = config.healthCheckPath;
  plan.rollback.scalingTarget = structuredClone(config.scalingTarget);
  const mutableNames = new Set(['PACKPROOF_RELEASE_SHA','PACKPROOF_RELEASE_IMAGE','PACKPROOF_RELEASE_VERSION',...Object.keys(changes)]);
  const preserve = c => ({...c, image:undefined, environment:c.environment.filter(x => !mutableNames.has(x.name))});
  if (hash(preserve(original)) !== hash(preserve(container))) throw Error('UNEXPECTED_PRODUCTION_CHANGE');
  plan.summary.permittedChanges.push(...Object.keys(changes).map(name => `primaryContainer.environment.${name}`), 'healthCheckPath','scalingTarget');
  plan.summary.production = {environment:'production', credentialNamespace:namespace, healthCheckPath:'/ready', taskCount,
    customerDatabasePreserved:true, cognitoPreserved:true, evidenceBucketPreserved:true, rolesAndSecretReferencesPreserved:true};
  return plan;
}
