import { SIGNAL_ENABLED } from '../signal/Signal';
import { useEffect, useState } from "react";

/** Composition-only rollback; never changes capture databases, journals, or evidence. */
export function mobileTaskExperienceEnabled() {
  return import.meta.env.VITE_PACKPROOF_MOBILE_TASK_UX !== "false";
}
export function useMobileTaskExperience() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  // Dashboard builds use the workstation composition on larger screens. Keep
  // the existing narrow-screen capture/recovery composition for every flag
  // combination; opting in must not force a desktop task flow onto a phone.
  const desktopDashboard = import.meta.env.VITE_PACKPROOF_CLIENT_DASHBOARD === 'true' && !compact;
  return SIGNAL_ENABLED && !desktopDashboard || compact && mobileTaskExperienceEnabled();
}
