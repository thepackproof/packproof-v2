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
  return compact && mobileTaskExperienceEnabled();
}
