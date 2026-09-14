import { useEffect, useState } from "react";
import type { PackProofApi } from "../api/client";

/** Server-confirmed and memory-only; never inherit a previous account's capability. */
export function useDeveloperAccess(api: PackProofApi, accountKey: string, enabled: boolean) {
  const [grant, setGrant] = useState<{ api: PackProofApi; accountKey: string; allowed: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      setGrant(null);
      if (!enabled || !accountKey || document.visibilityState === "hidden") return;
      void api.getDeveloperAccess().then(result => {
        if (active && current === revision) setGrant({ api, accountKey, allowed: result?.allowed === true });
      }).catch(() => {
        if (active && current === revision) setGrant({ api, accountKey, allowed: false });
      });
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; revision++; document.removeEventListener("visibilitychange", refresh); };
  }, [api, accountKey, enabled]);
  return enabled && grant?.api === api && grant.accountKey === accountKey && grant.allowed;
}
