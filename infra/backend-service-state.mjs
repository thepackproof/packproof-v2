/** Pure ECS response reconciliation; service revisions own CANARY workload settings. */
export function serviceWithRevision(service, revision) {
  if (!service?.serviceArn || revision?.serviceArn !== service.serviceArn || !revision.taskDefinition) {
    throw Error('SERVICE_REVISION_IDENTITY_MISMATCH');
  }
  const result = structuredClone(service);
  for (const field of ['taskDefinition', 'capacityProviderStrategy', 'launchType', 'platformVersion', 'networkConfiguration', 'loadBalancers']) {
    if (revision[field] !== undefined) result[field] = structuredClone(revision[field]);
  }
  return result;
}

/** Error category only: never retain raw stderr, credentials, paths or request values. */
export function awsFailureCode(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : error?.stderr?.toString?.() ?? '';
  const code = stderr.match(/An error occurred \(([A-Za-z0-9_.-]{1,80})\) when calling/)?.[1];
  if (code) return code;
  if (/Invalid choice|Unknown options:|Parameter validation failed|expected one argument/i.test(stderr)) return 'CLI_ARGUMENT_ERROR';
  if (error?.code === 'ERR_INVALID_ARG_TYPE') return 'LOCAL_ARGUMENT_ERROR';
  if (error?.code === 'ETIMEDOUT') return 'CLI_TIMEOUT';
  return 'AWS_CALL_FAILED';
}
