import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'thepackproof/packproof-v2';
const stackName = 'packproof-desktop-updates';
const apiOrigin = 'https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws';
const webOrigin = 'https://dvpmnwc27i8tw.cloudfront.net';
const environments = ['connect-production', 'connect-production-publish'];

function command(program, args, input) {
  return execFileSync(program, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}

function github(method, endpoint, data, pages = false, missingAllowed = false) {
  const args = ['api', '--hostname', 'github.com', '--method', method, '-H', 'X-GitHub-Api-Version: 2022-11-28'];
  if (pages) args.push('--paginate', '--slurp');
  if (data) args.push('--input', '-');
  const call = spawnSync('gh', [...args, 'repos/' + repository + '/' + endpoint], { encoding:'utf8', input:data ? JSON.stringify(data) : undefined });
  if (call.error) throw call.error;
  if (call.status !== 0) {
    if (missingAllowed && /\(HTTP 404\)/.test(call.stderr)) return null;
    throw Error('GitHub ' + method + ' ' + endpoint + ' failed. Check administrator access and environment permissions.');
  }
  return call.stdout.trim() ? JSON.parse(call.stdout) : null;
}

export function publicSettings(stack, publish) {
  if (!stack.StackId?.startsWith('arn:aws:cloudformation:us-east-1:784514617543:stack/' + stackName + '/') ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus)) throw Error('Select the completed PackProof downloads stack in us-east-1.');
  const out = Object.fromEntries(stack.Outputs.map(x => [x.OutputKey, x.OutputValue]));
  if (out.ActivationState !== 'ACTIVE' || !out.ReleaseBucketName) throw Error('The active downloads bucket is required.');
  const values = { PACKPROOF_API_BASE_URL: apiOrigin, PACKPROOF_WEB_BASE_URL: webOrigin };
  if (publish) {
    values.PACKPROOF_RELEASE_BUCKET = out.ReleaseBucketName;
    if (out.ConnectProductionPublishRoleArn) {
      if (!/^arn:aws:iam::784514617543:role\/packproof\/connect\/[\w+=,.@-]+$/.test(out.ConnectProductionPublishRoleArn)) throw Error('Unexpected Connect publish role.');
      values.PACKPROOF_RELEASE_ROLE_ARN = out.ConnectProductionPublishRoleArn;
    }
  }
  return values;
}

export function reviewPolicy(source) {
  const rules = source.protection_rules || [];
  if (rules.some(r => !['branch_policy','wait_timer','required_reviewers'].includes(r.type))) throw Error('Inspect additional protection rules in ' + source.name + ' before creating a matching Connect environment.');
  const approval = rules.find(r => r.type === 'required_reviewers');
  const reviewers = (approval?.reviewers || []).map(r => ({ type: r.type, id: r.reviewer.id }));
  if (!reviewers.length || reviewers.some(r => !['Team','User'].includes(r.type) || !Number.isSafeInteger(r.id))) throw Error('The reference production environment needs identifiable required reviewers.');
  if (typeof source.can_admins_bypass !== 'boolean') throw Error('Could not determine the existing administrator bypass policy.');
  return { reviewers, prevent_self_review: approval.prevent_self_review === true,
    wait_timer: rules.find(r => r.type === 'wait_timer')?.wait_timer || 0, can_admins_bypass: source.can_admins_bypass,
    deployment_branch_policy: { protected_branches:false, custom_branch_policies:true } };
}

function comparePolicies(before, after) {
  const ordered = policy => ({ ...policy, reviewers:[...policy.reviewers].sort((a,b) => a.id-b.id || a.type.localeCompare(b.type)) });
  return JSON.stringify(ordered(before)) === JSON.stringify(ordered(after));
}

export async function configure({ stack, api = github, apply = false, log = console.log }) {
  // Listing first distinguishes an absent environment from a denied read.
  const inventory = new Map(api('GET', 'environments?per_page=100', null, true)
    .flatMap(p => p.environments).map(e => [e.name, e]));
  const actions = [];
  for (const name of environments) {
    const base = 'environments/' + name;
    const existing = inventory.get(name);
    const values = publicSettings(stack, name.endsWith('-publish'));
    let policy;
    if (!existing) {
      const sourceName = name.replace('connect-', 'desktop-');
      policy = reviewPolicy(api('GET', 'environments/' + sourceName));
      log(name + ' will use the review protections of ' + sourceName);
    } else if (!existing.deployment_branch_policy?.custom_branch_policies || existing.deployment_branch_policy.protected_branches) {
      throw Error('Set ' + name + ' to selected deployment branches in GitHub Settings, preserving its existing reviewer and protection rules, then rerun.');
    }
    const branches = existing ? api('GET', base + '/deployment-branch-policies?per_page=100', null, true).flatMap(p => p.branch_policies) : [];
    if (branches.some(b => b.type !== 'branch' || b.name !== 'main')) throw Error('Remove other branch or tag policies from ' + name + ' in GitHub Settings, then rerun.');
    actions.push({ name, base, policy, needsBranch: !branches.length, values });
  }
  for (const { name, base, policy, needsBranch, values } of actions) {
    if (apply && policy) {
      const created = api('PUT', base, policy);
      if (!created.deployment_branch_policy?.custom_branch_policies || created.deployment_branch_policy.protected_branches ||
          !comparePolicies(policy, reviewPolicy(created))) throw Error('GitHub did not confirm the expected protections for ' + name + '.');
    }
    if (needsBranch && apply) api('POST', base + '/deployment-branch-policies', { name:'main', type:'branch' });
    if (apply) {
      const rules = api('GET', base + '/deployment-branch-policies?per_page=100', null, true).flatMap(p => p.branch_policies);
      if (rules.length !== 1 || rules[0].type !== 'branch' || rules[0].name !== 'main') throw Error('Main-only deployment policy was not confirmed for ' + name);
    }
    log(name + ' | main branch | ' + Object.keys(values).join(', '));
    // Query only the four public variable names this command manages. Never list or read signing values.
    if (apply) {
      for (const [key, value] of Object.entries(values)) {
        const current = api('GET', base + '/variables/' + key, null, false, true);
        if (current?.value === value) continue;
        const method = current ? 'PATCH' : 'POST';
        const endpoint = base + '/variables' + (method === 'PATCH' ? '/' + key : '');
        api(method, endpoint, { name:key, value });
      }
    }
  }
  const ready = Boolean(actions[1].values.PACKPROOF_RELEASE_ROLE_ARN);
  if (!ready) log('ConnectProductionPublishRoleArn is pending. Rerun after the downloads change set finishes to populate the publisher role.');
  return { applied:apply, publisherRoleAvailable:ready };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.slice(2).some(a=>a!=='--apply')) throw Error('Run with no arguments for a preview, or pass --apply.');
    const result = JSON.parse(command('aws', ['cloudformation','describe-stacks','--stack-name',stackName,'--region','us-east-1','--output','json','--no-cli-pager']));
    const apply = process.argv.includes('--apply');
    if (!apply) console.log('Read-only preview.');
    const state = await configure({ stack:result.Stacks[0], apply });
    if (!state.publisherRoleAvailable) process.exitCode=2;
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
