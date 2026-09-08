// Host must supply consent, account fencing, and its own durable journal adapter.
// There is no default telemetry or network activity when this module is imported.
export {createConsentedTimingBridge} from '../../../mobile/src/analytics/timing-bridge';
export type {StudyConsent,TimingCheckpoint,TimingStart,TimingJournal,TimingBridgeStore,TimingBridgeApi} from '../../../mobile/src/analytics/timing-bridge';
