/** Public first-party connection-health projection. Provider credentials and raw
 * order payloads are never returned by this contract. */
export interface ConnectionHealthView {
  schema:'packproof.connection-health/v1';connectionId:string;provider:string;observedAt:string;status:string;
  capabilities:{
    stableAccountId:string|null;automationAvailable:boolean;automationUnavailableReason:string|null;
    exactOrderReadSupported:boolean;incrementalListSupported:boolean;orderReadVerified:boolean;lastOrderReadAt:string|null;
    webhookSubscriptionsVerified:boolean;webhookDeliveryVerified:boolean;lastWebhookReceivedAt:string|null;
  };
  automation:{optedIn:boolean;paused:boolean};
  sync:{
    runStatus:string;retryable?:boolean;reconnectRequired?:boolean;sourceWatermarkAt:string|null;
    sourceAgeSeconds:number|null;stale:boolean|null;pageResumePending:boolean;expiredLease:boolean;
    pendingProviderEvents:number;oldestPendingProviderEventAt:string|null;
  };
  coverage:{
    basis:'DISCOVERED_SOURCE_RECORDS';discovered:number;eligible:number;excluded:number;eligibleWithoutProof:number;
    awaitingCapture:number;inProgress:number;finalized:number;otherEligible:number;oldestAwaitingCaptureAt:string|null;
    reviewOrderCount:number;reviewReasons:Array<{code:string;count:number}>;
  };
  nextAction:'RECONNECT'|'NO_ORDER_IMPORT'|'CONTACT_SUPPORT'|'RETRY_SYNC'|'ENABLE_AUTOMATION'|'WAIT'|'NONE';
}
