/** Build-time composition switch; never flip presentation during capture. */
export const SIGNAL_ENABLED = process.env.EXPO_PUBLIC_PACKPROOF_SIGNAL !== 'false';
