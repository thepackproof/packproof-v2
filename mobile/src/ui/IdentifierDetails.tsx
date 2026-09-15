import { useState } from 'react';
import { Text, View } from 'react-native';
import type { IdentifierReview } from '../../../backend/src/identifiers/types';
import { identifierTime } from '../capture/identifier-observation';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from './Button';

type IdentifierProjection = { coverage: string; observations: IdentifierReview['observations'] };

/** Renders the authorized canonical projection only; decoded strings never become links. */
export function IdentifierDetails({ value }: { value: IdentifierProjection | null | undefined }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(20);
  if (!value) return null;
  return <View style={{ gap: 8 }}>
    <Button label={`${expanded ? 'Hide' : 'Show'} observed codes${value.observations.length ? ` · ${value.observations.length}` : ''}`} variant="tertiary" onPress={() => setExpanded(!expanded)} />
    {expanded ? <>
      <Text style={{ color: colors.textSecondary }}>{value.coverage === 'COMPLETE'
        ? 'These code observations do not establish packed quantity or prove that an item entered the package.'
        : 'Some code observations were unavailable. The original recording is retained.'}</Text>
      {value.observations.slice(0, limit).map(row => <View key={row.observationId} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 10, gap: 6 }}>
        <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>{row.product?.title ?? (row.route === 'SHIPPING' ? 'Shipping code' : 'Observed item code')}</Text>
        <Text style={{ color: colors.textSecondary }}>{row.state === 'MATCH' ? 'Matches an identifier in the selected order'
          : row.state === 'CONFLICT' ? 'Differs from the selected order'
          : row.state === 'RESOLVED_PRODUCT' ? 'Details found in the connected catalog'
          : row.state === 'AMBIGUOUS' ? 'Several interpretations remain possible'
          : row.state === 'STALE' ? 'Source details are out of date' : 'Item details unavailable'}</Text>
        {row.product?.variant ? <Text style={{ color: colors.textSecondary }}>{row.product.variant}</Text> : null}
        {row.identifiers.map((identifier, index) => <Text selectable key={`${identifier.type}:${index}`} style={{ color: colors.textPrimary }}>
          {identifier.type === 'CONTAINED_GTIN' ? 'Contained item GTIN' : identifier.type}: {identifier.normalizedValue ?? identifier.value}
          {identifier.validationResult !== 'VALID' ? ` · ${identifier.validationResult.toLowerCase()}` : ''}
        </Text>)}
        {row.expected.length ? <Text style={{ color: colors.textSecondary }}>Expected: {row.expected.map(item => [item.title, item.sku && `SKU ${item.sku}`, item.gtin && `GTIN ${item.gtin}`].filter(Boolean).join(' · ')).join('; ')}</Text> : null}
        {row.product ? <Text style={{ color: colors.textSecondary }}>Source: {row.product.sourceKind === 'ORDER_SNAPSHOT' ? 'selected order snapshot' : 'connected catalog'} · revision {row.product.sourceRevision}</Text> : null}
        <Text style={{ color: colors.textSecondary }}>{identifierTime(row)}</Text>
        {row.supplemental ? <Text style={{ color: colors.textSecondary }}>Supplemental interpretation; the original sealed record is unchanged.</Text> : null}
        {row.decision ? <Text style={{ color: colors.textSecondary }}>{row.decision.decision === 'NOT_THIS_SHIPMENT' ? 'Marked as outside this shipment' : 'Mismatch acknowledged'} · {row.decision.reason} · {row.decision.actorId} · {row.decision.createdAt}</Text> : null}
      </View>)}
      {value.observations.length > limit ? <Button label="Show more codes" variant="tertiary" onPress={() => setLimit(limit + 20)} /> : null}
    </> : null}
  </View>;
}
