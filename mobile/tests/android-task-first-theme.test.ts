import assert from 'node:assert/strict';
import test from 'node:test';
import { colorsForScheme, darkColors, lightColors, taskFirstTypography, type ThemeColors } from '../src/theme/tokens';

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test('legacy color selection is unchanged unless the Android presentation is requested', () => {
  assert.equal(colorsForScheme('light'), lightColors);
  assert.equal(colorsForScheme('dark'), darkColors);
  assert.equal(colorsForScheme('light', false), lightColors);
  assert.equal(colorsForScheme('dark', false), darkColors);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme} task-first readable text and button pairs meet 4.5:1`, () => {
    const colors = colorsForScheme(scheme, true);
    const pairs: [keyof ThemeColors, keyof ThemeColors][] = [
      ['textPrimary', 'background'], ['textSecondary', 'background'],
      ['textPrimary', 'surface'], ['textSecondary', 'surface'],
      ['textPrimary', 'surfacePressed'], ['textSecondary', 'surfacePressed'],
      ['textOnPrimary', 'primary'], ['textOnPrimary', 'primaryPressed'],
      ['accentText', 'accentSoft'], ['successText', 'successSoft'],
      ['warningText', 'warningSoft'], ['error', 'errorSoft'],
      ['disabledText', 'disabledBackground'],
    ];
    for (const [foreground, background] of pairs) {
      const ratio = contrast(colors[foreground], colors[background]);
      assert.ok(ratio >= 4.5, `${scheme} ${foreground}/${background}: ${ratio.toFixed(2)}:1`);
    }
  });
}

test('task-first type hierarchy permits native scaling without fixed text bounds', () => {
  assert.ok(taskFirstTypography.pageTitle.fontSize > taskFirstTypography.sectionTitle.fontSize);
  assert.ok(taskFirstTypography.sectionTitle.fontSize > taskFirstTypography.body.fontSize);
  for (const style of Object.values(taskFirstTypography)) {
    assert.ok(style.lineHeight > style.fontSize);
    assert.ok(!('height' in style));
    assert.ok(!('maxFontSizeMultiplier' in style));
  }
});
