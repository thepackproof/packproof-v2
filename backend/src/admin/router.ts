import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { DomainError } from "../domain/errors.js";
import { analyticsSection, trend, type Query } from "./analytics.js";
import {
  errorDetail,
  evidenceDetail,
  integrationDetail,
  webhookDetail,
  activity,
  auditSection,
  billingSection,
  errorsSection,
  evidenceSection,
  integrationsSection,
  integrityCheck,
  overview,
  proofDetail,
  proofsSection,
  search,
  userDetail,
  usersSection,
  type AdminReadDeps,
} from "./read.js";
import { versionsSection } from "./client-versions.js";
import { infrastructureSection, platformHealth } from "./infrastructure.js";
/** Mounted after authentication + requireSystemAdmin by the application. */
export function adminRouter(input: AdminReadDeps) {
  const boundedDb = {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      input.db.transaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '3000ms'");
        return tx.query<T>(sql, params);
      }),
    transaction: input.db.transaction.bind(input.db),
  };
  const deps: AdminReadDeps = { ...input, db: boundedDb };
  const router = Router();
  const cache = new Map<
    string,
    {
      expires: number;
      pending: Promise<unknown>;
    }
  >();
  function cached(key: string, fn: () => Promise<unknown>) {
    const old = cache.get(key);
    if (old && old.expires > Date.now()) return old.pending;
    if (cache.size >= 30) cache.delete(cache.keys().next().value!);
    const pending = fn().catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, { expires: Date.now() + 30000, pending });
    return pending;
  }
  function get(path: string, fn: (req: Request) => Promise<unknown>) {
    router.get(path, (req: Request, res: Response, next: NextFunction) => {
      res.set("Cache-Control", "private, no-store");
      void fn(req)
        .then((value) => res.json(value))
        .catch(next);
    });
  }
  const q = (req: Request) => req.query as Query;
  get("/overview", async (req) =>
    cached(`overview:${JSON.stringify(q(req))}`, async () => {
      const [data, health] = await Promise.all([
        overview(deps, q(req)),
        platformHealth(deps),
      ]);
      return { ...data, health };
    }),
  );
  get("/activity", async (req) => ({ activity: await activity(deps, q(req)) }));
  get("/search", (req) => search(deps, q(req)));
  get("/users", (req) => usersSection(deps, q(req)));
  get("/users/:id", (req) =>
    userDetail(deps, req.params.id, req.packproofUserId),
  );
  get("/proofs", (req) => proofsSection(deps, q(req)));
  get("/evidence/:id", (req) => evidenceDetail(deps, req.params.id));
  get("/errors/:id", (req) => errorDetail(deps, req.params.id));
  get("/integrations/:id", (req) => integrationDetail(deps, req.params.id));
  get("/webhooks/:id", (req) => webhookDetail(deps, req.params.id));
  get("/proofs/:id", (req) => proofDetail(deps, req.params.id));
  get("/proofs/:id/integrity", (req) =>
    cached(`integrity:${req.params.id}`, () =>
      integrityCheck(deps, req.params.id),
    ),
  );
  get("/analytics/trend", (req) =>
    cached(`trend:${JSON.stringify(q(req))}`, () =>
      trend(deps.db, deps.clock, q(req)),
    ),
  );
  const sections: Record<string, (query: Query) => Promise<unknown>> = {
    users: (q) => usersSection(deps, q),
    proofs: (q) => proofsSection(deps, q),
    evidence: (q) => evidenceSection(deps, q),
    integrations: (q) => integrationsSection(deps, q),
    analytics: (q) =>
      q.view === "versions"
        ? versionsSection(deps, q)
        : analyticsSection(deps.db, deps.clock, q),
    versions: (q) => versionsSection(deps, q),
    billing: (q) => billingSection(deps, q),
    errors: (q) => errorsSection(deps, q),
    security: (q) => auditSection(deps, q, true),
    audit: (q) => auditSection(deps, q),
    infrastructure: (q) => infrastructureSection(deps, q),
  };
  get("/sections/:section", async (req) => {
    if (!Object.hasOwn(sections, req.params.section))
      throw new DomainError(
        "ADMIN_SECTION_NOT_FOUND",
        "Unknown administration section",
        404,
      );
    const fn = sections[req.params.section];
    return req.params.section === "analytics"
      ? cached(`analytics:${JSON.stringify(q(req))}`, () => fn(q(req)))
      : fn(q(req));
  });
  for (const name of [
    "evidence",
    "integrations",
    "analytics",
    "billing",
    "errors",
    "security",
    "audit",
    "infrastructure",
  ])
    get(`/${name}`, (req) => sections[name](q(req)));
  return router;
}
