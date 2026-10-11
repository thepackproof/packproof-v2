/** Build-time composition flag. It cannot change underneath an active capture or submission. */
export const FIRST_PROOF_EXPERIENCE_ENABLED = process.env.EXPO_PUBLIC_PACKPROOF_FIRST_PROOF_EXPERIENCE === "true";
export const FIRST_PROOF_FLOW_VERSION = 1;
