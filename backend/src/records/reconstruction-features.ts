import {DomainError} from '../domain/errors.js';

/** Independent admission/read switches. No new capability is enabled by default. */
export const RECONSTRUCTION_FLAGS={
 typedIntake:'PACKPROOF_TYPED_INTAKE_ENABLED',
 sourceSubscriptions:'PACKPROOF_SOURCE_SUBSCRIPTIONS_ENABLED',
 multiSourceAgent:'PACKPROOF_MULTI_SOURCE_AGENT_ENABLED',
 reconstruction:'PACKPROOF_CASE_RECONSTRUCTION_ENABLED',
 sourceHealth:'PACKPROOF_SOURCE_HEALTH_ENABLED',
 rules:'PACKPROOF_RECONSTRUCTION_RULES_ENABLED',
 exports:'PACKPROOF_RECONSTRUCTION_EXPORTS_ENABLED',
 sourceIdentityV2:'PACKPROOF_SOURCE_IDENTITY_V2_ENABLED',
 crossCase:'PACKPROOF_CROSS_CASE_ENABLED',
 sourceRulePolicies:'PACKPROOF_SOURCE_RULE_POLICIES_ENABLED',
 pagedProjections:'PACKPROOF_PAGED_PROJECTIONS_ENABLED',
 signedExports:'PACKPROOF_SIGNED_CASE_EXPORTS_ENABLED',
 sourceDisposition:'PACKPROOF_SOURCE_DISPOSITION_ENABLED',
} as const;
export type ReconstructionFeature=keyof typeof RECONSTRUCTION_FLAGS;
export function reconstructionFeatureEnabled(feature:ReconstructionFeature){return process.env[RECONSTRUCTION_FLAGS[feature]]==='true';}
/** Explicit candidate compatibility; expanding this set requires parity and
 * migration qualification, not a guessed semver range. */
export function typedCollectorVersionSupported(version:string,batchSchema='packproof.typed-source-batch/v1'){
 return batchSchema==='packproof.typed-source-batch/v1'?(version==='0.2.0'||version==='0.3.0'):
  batchSchema==='packproof.typed-source-batch/v2'&&version==='0.3.0';
}
export function requireReconstructionFeature(feature:ReconstructionFeature){
 if(!reconstructionFeatureEnabled(feature))throw new DomainError('RECONSTRUCTION_CAPABILITY_DISABLED','This operational source capability is awaiting qualification and activation',503);
}
