import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { PackProofV2Client } from "../v2-api";

export function useDeveloperAccess(client: PackProofV2Client, userId: string, ensureAuth: () => Promise<unknown>) {
  const authenticate = useRef(ensureAuth);
  authenticate.current = ensureAuth;
  const [grant, setGrant] = useState<{ client: PackProofV2Client; userId: string; allowed: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = (state: string) => {
      const current = ++revision;
      setGrant(null);
      if (!userId || state !== "active") return;
      void authenticate.current().then(async () => {
        if (!active || current !== revision) return;
        client.assertCaptureAccount(userId, client.apiBaseUrl);
        const result = await client.getDeveloperAccess();
        if (active && current === revision) setGrant({ client, userId, allowed: result?.allowed === true });
      }).catch(() => { if (active && current === revision) setGrant({ client, userId, allowed: false }); });
    };
    refresh(AppState.currentState);
    const listener = AppState.addEventListener("change", refresh);
    return () => { active = false; revision++; listener.remove(); };
  }, [client, userId]);
  return grant?.client === client && grant.userId === userId && grant.allowed;
}
