import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { dispatchWebhooks, type WebhookConfig } from "./webhooks.js";

/** PostgreSQL leases allow multiple API replicas without duplicate ownership. */
export function startWebhookWorker(db: Database, clock: Clock, config: WebhookConfig) {
  let active: Promise<void> | null = null;
  const tick = () => {
    if (active) return;
    active = dispatchWebhooks(db, clock, config, undefined, 5)
      .then((result) => {
        if (result.failed)
          console.warn(
            JSON.stringify({
              event: "webhook_delivery_retry",
              failed: result.failed,
            }),
          );
      })
      .catch(() => console.error(JSON.stringify({ event: "webhook_worker_failed" })))
      .finally(() => {
        active = null;
      });
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
