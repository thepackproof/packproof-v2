import { useState } from 'react';
import { Text, View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { AppScreen } from '../ui/AppScreen';
import { AppHeader } from '../ui/AppHeader';
import { Button } from '../ui/Button';
import { CompactProofRow } from '../ui/CompactProofRow';
import { FormField } from '../ui/FormField';
import { ErrorBanner } from '../ui/EmptyState';

export function CreateScreen() {
  const app = usePackProof(), { colors } = useTheme();
  const [grading, setGrading] = useState(false), [title, setTitle] = useState(''), [count, setCount] = useState('1');
  const pending = app.gradingCreation;
  const itemCount = Number(count);
  return <AppScreen><AppHeader title="Create Proof" onBack={grading ? () => setGrading(false) : app.goBack} /><ErrorBanner message={app.error} />
    {pending ? <View style={{ gap: 12 }}>
      <Text style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '600' }}>Resume creation</Text>
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>{pending.itemTitle} · {pending.itemCount} {pending.itemCount === 1 ? 'item' : 'items'}. Check the saved request before starting another grading Proof.</Text>
      <Button label="Recover creation" disabled={app.offline} loading={app.busy} onPress={() => void app.createGradingProof()} />
    </View> : grading ? <View style={{ gap: 16 }}>
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>Document each item's front and back, then follow the required packing and handoff steps.</Text>
      <FormField label="What are you documenting?" value={title} onChangeText={setTitle} maxLength={200} autoCapitalize="sentences" />
      <FormField label="Number of items (1–20)" value={count} onChangeText={text => setCount(text.replace(/[^0-9]/g, '').slice(0, 2))} keyboardType="number-pad" />
      <Button label="Continue to photos" disabled={app.offline || !title.trim() || !Number.isInteger(itemCount) || itemCount < 1 || itemCount > 20} loading={app.busy} onPress={() => void app.createGradingProof(itemCount, title.trim())} />
    </View> : <View style={{ gap: 12 }}>
      <Text style={{ color: colors.textSecondary, fontSize: 16, lineHeight: 24 }}>What would you like to document?</Text>
      <CompactProofRow title="Record a shipment" detail="One continuous packing video" onPress={() => app.go('manual')} />
      <CompactProofRow title="Document items for grading" detail="Front and back photos, packing and handoff" onPress={() => setGrading(true)} />
      <CompactProofRow title="Use an existing order" detail="Choose a connected order or scan its reference" onPress={() => app.go('orders')} />
    </View>}
    {app.offline ? <Text style={{ color: colors.textSecondary, fontSize: 14 }}>Reconnect to create a Proof. Your entered details stay here.</Text> : null}
  </AppScreen>;
}
