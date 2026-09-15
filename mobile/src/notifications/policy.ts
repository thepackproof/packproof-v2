export type NotificationPreferences = { enabled: boolean; uploads: boolean; evidence: boolean; participants: boolean; shipments: boolean; returns: boolean };

/** Server push owns completion when registered, preventing a second local alert. */
export function shouldNotifyUploadLocally(preferences: NotificationPreferences | null, remotePushRegistered: boolean, mutedProofs: readonly string[], proofId: string): boolean {
  return preferences?.enabled === true && preferences.uploads === true && !remotePushRegistered && !mutedProofs.includes(proofId);
}
