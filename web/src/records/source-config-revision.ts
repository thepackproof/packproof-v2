import type { SourceConfig, SourceSubscription } from './SourceSubscriptions';
import type { PolicySource } from './source-policy-types';
/** A self-bound rule follows the proposed immutable config revision; other sources retain exact grants. */
export function nextSourceConfig(source: SourceSubscription, changes: Partial<SourceConfig>): SourceConfig {
  const config = { ...source.config, ...changes }, rules = config.rulePolicies;
  const bind = (binding: PolicySource) => binding.subscriptionId === source.id ? { ...binding, configurationRevision: source.configurationRevision + 1 } : binding;
  if (!rules) return config;
  return { ...config, rulePolicies: { ...rules,
    ...(rules.labelAcceptance ? { labelAcceptance: { ...rules.labelAcceptance, labelSource: bind(rules.labelAcceptance.labelSource), acceptanceSource: bind(rules.labelAcceptance.acceptanceSource) } } : {}),
    ...(rules.handlingUnitHandoff ? { handlingUnitHandoff: { ...rules.handlingUnitHandoff, expectationSource: bind(rules.handlingUnitHandoff.expectationSource), loadingSource: bind(rules.handlingUnitHandoff.loadingSource), receiptSource: bind(rules.handlingUnitHandoff.receiptSource) } } : {}) } };
}
