import { Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { AppScreen } from '../ui/AppScreen';
import { AppHeader } from '../ui/AppHeader';
import { Button } from '../ui/Button';
import { EvidenceResponsePanel } from '../supporting/EvidenceResponsePanel';
import { MediaPrivacyTools } from '../supporting/MediaPrivacyTools';
import { RetentionPanel } from '../supporting/RetentionPanel';

export function SupportingToolsScreen() {
  const app = usePackProof(), { colors } = useTheme(), proof = app.proof, session = app.session;
  const section = app.route.supportingSection ?? 'responses';
  const title = section === 'retention' ? 'Retention and preservation' : section === 'privacy' ? 'Private media copies' : 'Responses and corrections';
  if (!proof || !session) return <AppScreen><AppHeader title={title} onBack={app.goBack} /><Text style={[typography.body, { color: colors.textPrimary }]}>Open a Proof to use these tools.</Text></AppScreen>;
  const scopeKey = JSON.stringify([app.apiBaseUrl, session.userId, proof.proofId]);
  return <AppScreen>
    <AppHeader title={title} onBack={app.goBack} />
    <View style={{ gap: 8, marginBottom: 20 }}>
      {section !== 'responses' ? <Button label="Responses and corrections" variant="tertiary" onPress={() => app.go('supporting', { supportingSection: 'responses' })} /> : null}
      {section !== 'retention' ? <Button label="Retention and preservation" variant="tertiary" onPress={() => app.go('supporting', { supportingSection: 'retention' })} /> : null}
      {app.role === 'SELLER' && section !== 'privacy' ? <Button label="Private media copies" variant="tertiary" onPress={() => app.go('supporting', { supportingSection: 'privacy' })} /> : null}
    </View>
    {section === 'responses' ? <EvidenceResponsePanel key={scopeKey} proofId={proof.proofId} userId={session.userId} role={app.role ?? ''} /> : null}
    {section === 'retention' ? <RetentionPanel key={scopeKey} proofId={proof.proofId} userId={session.userId} /> : null}
    {section === 'privacy' ? app.role === 'SELLER' ? <MediaPrivacyTools key={scopeKey} proof={proof} /> : <Text style={[typography.body, { color: colors.textPrimary }]}>The seller manages private media copies for this Proof.</Text> : null}
  </AppScreen>;
}
