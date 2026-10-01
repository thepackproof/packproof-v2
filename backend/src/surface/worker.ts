import { surfaceMethodPin } from './method.js';
import { SURFACE_METHOD } from './config.js';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppDependencies } from '../app.js';
import type { Database } from '../db/database.js';
import { canonicalize } from '../canonical.js';
import { sha256Hex } from '../hash.js';
import { newId } from '../ids.js';
import { appendAudit } from '../domain/audit.js';
import { appendExtension, config, scopedRecord, source, fail } from './service.js';
import { surfaceCapabilities } from './config.js';
import type { SurfaceSource } from './types.js';
export interface SurfaceJob {
  id: string;
  proof_id: string;
  record_id: string;
  operation: 'extract' | 'compare';
  attempts: number;
  lease_token: string;
}
export type SurfaceRunner = (input: Record<string, unknown>, mediaRoot: string, workDir: string) => Promise<Record<string, any>>;
/** Lease token fences late workers. Every completion and error checks the owning lease. */
export async function claimSurfaceJob(deps: AppDependencies): Promise<SurfaceJob | null> {
  const cap = surfaceCapabilities(config(deps));
  if (!cap.extraction && !cap.internalComparison) return null;
  return deps.db.transaction(async tx => {
    const now = deps.clock.now().toISOString();
    const row = (await tx.query<SurfaceJob>(`SELECT * FROM surface_jobs WHERE attempts<3 AND ((status='queued' AND available_at<=$1) OR (status='processing' AND lease_until<=$1)) AND ((operation='extract' AND $2::boolean) OR (operation='compare' AND $3::boolean)) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [now, cap.extraction, cap.internalComparison])).rows[0];
    if (!row) return null;
    const token = randomUUID(),
      lease = new Date(deps.clock.now().getTime() + Math.max(120000, config(deps).timeoutMs * 3)).toISOString();
    await tx.query("UPDATE surface_jobs SET status='processing',attempts=attempts+1,lease_token=$2,lease_until=$3,error_code=NULL WHERE id=$1", [row.id, token, lease]);
    return {
      ...row,
      attempts: row.attempts + 1,
      lease_token: token
    };
  });
}
function restrictedResult(value: Record<string, any>, job: SurfaceJob) {
  if (value.schemaVersion !== 'surface-result/1' || value.jobId !== job.id || value.qualification !== 'unqualified' || !['unsupported', 'inconclusive', 'not_checked'].includes(value.status) || !value.scopeResults || typeof value.scopeResults !== 'object') fail('SURFACE_WORKER_PROTOCOL', 'Worker returned an unsupported or qualified finding', 422);
  const scopes: Record<string, unknown> = {};
  for (const name of ['label', 'carton', 'assembly']) {
    const scope = value.scopeResults[name];
    if (!scope || !['unsupported', 'inconclusive', 'not_checked'].includes(scope.status) || !Array.isArray(scope.reasons) || scope.reasons.some((r: unknown) => typeof r !== 'string' || r.length > 1000)) fail('SURFACE_WORKER_PROTOCOL', 'Worker result has unsupported scope', 422);
    scopes[name] = {
      status: scope.status,
      reasons: scope.reasons
    };
  }
  if (!Array.isArray(value.limitations) || value.limitations.some((r: unknown) => typeof r !== 'string' || r.length > 2000) || !value.method || typeof value.method !== 'object') fail('SURFACE_WORKER_PROTOCOL', 'Worker result lacks method or limitations', 422);
  // Include only structural coverage. Never return raw match scores, descriptors or probe metrics.
  const coverage: Record<string, unknown> = {};
  if (value.coverage && typeof value.coverage === 'object') {
    for (const group of ['print', 'carton', 'context']) if (value.coverage[group]) {
      const c = value.coverage[group];
      coverage[group] = {
        required: c.required,
        usableEnrollmentRegions: c.usableEnrollmentRegions,
        usableObservationRegions: c.usableObservationRegions,
        comparedRegions: c.comparedRegions,
        observedRegisteredRegions: c.observedRegisteredRegions,
        completeForResearch: c.completeForResearch,
        state: c.state
      };
    }
  }
  const templateDigests: Record<string, string | null> = {};
  for (const role of ['enrollment', 'observation']) {
    const template = value.templates?.[role];
    if (template?.canonicalJson !== undefined) {
      if (typeof template.canonicalJson !== 'string' || sha256Hex(template.canonicalJson) !== template.artifactSha256) fail('SURFACE_WORKER_PROTOCOL', 'Template commitment failed', 422);
      templateDigests[role] = template.artifactSha256;
    } else templateDigests[role] = null;
  }
  return {
    templateDigests,
    schemaVersion: value.schemaVersion,
    jobId: job.id,
    status: value.status,
    qualification: 'unqualified',
    scopeResults: scopes,
    coverage,
    limitations: value.limitations,
    method: value.method,
    sourceDigests: value.sourceDigests ?? [],
    artifactSha256: value.artifactSha256 ?? null,
    privateArtifacts: 'WITHHELD'
  };
}
export function pythonSurfaceRunner(deps: AppDependencies): SurfaceRunner {
  return async (input, mediaRoot, workDir) => {
    const c = config(deps),
      inputPath = path.join(workDir, 'job.json'),
      outputPath = path.join(workDir, 'result.json');
    await writeFile(inputPath, canonicalize(input), {
      mode: 0o600
    });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(c.python, ['-m', 'packproof_surface', '--input', inputPath, '--output', outputPath, '--media-root', mediaRoot], {
        cwd: path.resolve(c.workerRoot),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          PYTHONPATH: path.resolve(c.workerRoot),
          OPENBLAS_NUM_THREADS: '1',
          OMP_NUM_THREADS: '1',
          MKL_NUM_THREADS: '1',
          PYTHONDONTWRITEBYTECODE: '1'
        },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      let errorBytes = 0;
      let stopped = false;
      const timer = setTimeout(() => {
        stopped = true;
        proc.kill('SIGKILL');
        reject(new Error('SURFACE_WORKER_TIMEOUT'));
      }, c.timeoutMs);
      proc.stderr.on('data', (data: Buffer) => {
        errorBytes += data.length;
        if (errorBytes > 65536) {
          stopped = true;
          proc.kill('SIGKILL');
          reject(new Error('SURFACE_WORKER_OUTPUT_LIMIT'));
        }
      });
      proc.on('error', () => {
        clearTimeout(timer);
        reject(new Error('SURFACE_WORKER_UNAVAILABLE'));
      });
      proc.on('close', code => {
        clearTimeout(timer);
        if (stopped) return;
        if (code !== 0) reject(new Error('SURFACE_WORKER_FAILED'));else resolve();
      });
    });
    if ((await stat(outputPath)).size > 4 * 1024 * 1024) throw new Error('SURFACE_WORKER_OUTPUT_LIMIT');
    return JSON.parse(await readFile(outputPath, 'utf8'));
  };
}
async function prepareCapture(deps: AppDependencies, db: Database, proofId: string, facts: Record<string, any>, mediaRoot: string) {
  const sources = [];
  for (const committed of facts.sourceDigests as SurfaceSource[]) {
    const row = await source(db, proofId, committed.sourceId);
    if (row.sha256 !== committed.sha256 || row.objectKey !== committed.objectKey || row.objectVersionId !== committed.objectVersionId) fail('SURFACE_SOURCE_SUBSTITUTION', 'Committed source identity changed', 422);
    const bytes = await deps.objectStore.get(row.objectKey, {
      versionId: row.objectVersionId
    });
    if (!bytes) throw new Error('SURFACE_SOURCE_EXPIRED');
    if (bytes.body.length !== row.byteSize || sha256Hex(bytes.body) !== row.sha256) throw new Error('SURFACE_SOURCE_INTEGRITY');
    const filename = `${row.sourceId}.${row.contentType === 'image/png' ? 'png' : 'jpg'}`;
    await writeFile(path.join(mediaRoot, filename), bytes.body, {
      mode: 0o600
    });
    sources.push({
      sourceId: row.sourceId,
      mediaPath: filename,
      sha256: row.sha256,
      frameTimeMs: committed.frameTimeMs
    });
  }
  return {
    captureProfileId: facts.captureProfileId,
    acquisition: facts.captureMode,
    sources,
    regions: facts.regionMap,
    requiredGroups: facts.requiredGroups,
    ...(Array.isArray(facts.deviceMetadata?.regionHints) ? {
      hints: facts.deviceMetadata.regionHints
    } : {})
  };
}
export async function processSurfaceJob(deps: AppDependencies, job: SurfaceJob, runner: SurfaceRunner = pythonSurfaceRunner(deps)) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'packproof-surface-'));
  try {
    const mediaRoot = path.join(workDir, 'media');
    await mkdir(mediaRoot, {
      mode: 0o700
    });
    const record = await scopedRecord(deps.db, job.proof_id, job.record_id),
      facts = JSON.parse(record.canonical_json);
    if (canonicalize(facts.method) !== canonicalize(await surfaceMethodPin(config(deps)))) throw new Error('SURFACE_METHOD_CHANGED');
    let enrollment = facts,
      observation: Record<string, any> | undefined;
    if (job.operation === 'compare') {
      enrollment = JSON.parse((await scopedRecord(deps.db, job.proof_id, facts.enrollmentId, 'enrollment')).canonical_json);
      observation = JSON.parse((await scopedRecord(deps.db, job.proof_id, facts.observationId, 'observation')).canonical_json);
    }
    const input = {
      schemaVersion: 'surface-job/1',
      jobId: job.id,
      operation: job.operation,
      profileId: facts.method.profileId,
      requestedScope: facts.requestedScope ?? 'assembly',
      enrollment: await prepareCapture(deps, deps.db, job.proof_id, enrollment, mediaRoot),
      ...(observation ? {
        observation: await prepareCapture(deps, deps.db, job.proof_id, observation, mediaRoot)
      } : {})
    };
    const raw = await runner(input, mediaRoot, workDir);
    if (Buffer.byteLength(canonicalize(raw)) > 4 * 1024 * 1024) throw new Error('SURFACE_WORKER_OUTPUT_LIMIT');
    for (const key of ['profileId', 'extractorVersion', 'descriptorVersion', 'scorerVersion', 'thresholdVersion', 'coverageVersion'] as const) if (raw.method?.[key] !== SURFACE_METHOD[key]) throw new Error('SURFACE_WORKER_METHOD_MISMATCH');
    const expectedSources = [...input.enrollment.sources.map(s => ({
      role: 'enrollment',
      sourceId: s.sourceId,
      sha256: s.sha256
    })), ...(input.observation?.sources ?? []).map(s => ({
      role: 'observation',
      sourceId: s.sourceId,
      sha256: s.sha256
    }))];
    if (canonicalize(raw.sourceDigests) !== canonicalize(expectedSources)) throw new Error('SURFACE_WORKER_SOURCE_MISMATCH');
    const result = restrictedResult(raw, job);
    if (raw.artifactCanonicalJson !== undefined && (typeof raw.artifactCanonicalJson !== 'string' || sha256Hex(raw.artifactCanonicalJson) !== raw.artifactSha256)) throw new Error('SURFACE_WORKER_ARTIFACT_DIGEST');
    await deps.db.transaction(async tx => {
      await loadJobProof(tx, job);
      const lease = (await tx.query<{
        lease_token: string;
        status: string;
        lease_until: Date | string;
      }>('SELECT lease_token,status,lease_until FROM surface_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
      if (lease.status !== 'processing' || lease.lease_token !== job.lease_token || new Date(lease.lease_until).getTime() <= deps.clock.now().getTime()) return;
      const id = newId('surface_analysis'),
        at = deps.clock.now().toISOString(),
        canonicalJson = canonicalize({
          schemaVersion: 'surface-analysis/1',
          id,
          proofId: job.proof_id,
          recordId: record.id,
          sourceRecordSha256: record.sha256,
          jobId: job.id,
          analyzedAt: at,
          result,
          privateArtifactSha256: sha256Hex(canonicalize(raw)),
          privateArtifactAvailability: 'WITHHELD'
        }),
        sha256 = sha256Hex(canonicalJson);
      await tx.query('INSERT INTO surface_analyses(id,proof_id,record_id,job_id,canonical_json,sha256,private_result_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [id, job.proof_id, record.id, job.id, canonicalJson, sha256, canonicalize(raw), at]);
      await appendExtension(deps, tx, job.proof_id, id, {
        kind: 'analysis',
        analysisId: id,
        analysisSha256: sha256,
        recordId: record.id,
        recordSha256: record.sha256
      });
      await tx.query("UPDATE surface_jobs SET status='completed',lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token]);
      await appendAudit(tx, {
        proofId: job.proof_id,
        actorUserId: null,
        eventType: 'SURFACE_ANALYSIS_COMMITTED',
        eventData: {
          analysisId: id,
          recordId: record.id,
          sha256,
          status: result.status
        },
        at: deps.clock.now()
      });
    });
    return {
      jobId: job.id,
      status: 'processed'
    };
  } catch (error) {
    const proposed = error instanceof Error ? error.message : '';
    const code = /^SURFACE_[A-Z_]+$/.test(proposed) ? proposed : 'SURFACE_WORKER_ERROR';
    await deps.db.transaction(async tx => {
      const updated = await tx.query("UPDATE surface_jobs SET status=CASE WHEN attempts>=3 THEN 'error' ELSE 'queued' END,available_at=$3,lease_token=NULL,lease_until=NULL,error_code=$4 WHERE id=$1 AND lease_token=$2 RETURNING id", [job.id, job.lease_token, new Date(deps.clock.now().getTime() + 30000 * job.attempts).toISOString(), code]);
      if (updated.rowCount) await appendAudit(tx, {
        proofId: job.proof_id,
        actorUserId: null,
        eventType: 'SURFACE_ANALYSIS_ATTEMPT_FAILED',
        eventData: {
          jobId: job.id,
          attempt: job.attempts,
          code
        },
        at: deps.clock.now()
      });
    });
    return {
      jobId: job.id,
      status: 'error',
      code
    };
  } finally {
    await rm(workDir, {
      recursive: true,
      force: true
    });
  }
}
async function loadJobProof(db: Database, job: SurfaceJob) {
  await db.query('SELECT id FROM proofs WHERE id=$1 FOR UPDATE', [job.proof_id]);
}
export async function dispatchSurfaceJobs(deps: AppDependencies, runner?: SurfaceRunner) {
  const cap = surfaceCapabilities(config(deps));
  if (!cap.extraction && !cap.internalComparison) return {
    status: 'disabled'
  };
  await deps.db.query("UPDATE surface_jobs SET status='error',error_code='SURFACE_WORKER_LEASE_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE status='processing' AND attempts>=3 AND lease_until<=$1", [deps.clock.now().toISOString()]);
  const job = await claimSurfaceJob(deps);
  return job ? processSurfaceJob(deps, job, runner) : {
    status: 'idle'
  };
}
