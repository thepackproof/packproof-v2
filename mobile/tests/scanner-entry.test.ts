import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { STATION_BARCODE_TYPES, normalizeStationReference } from '../src/packing-station/scan';

type Permission = { granted: boolean; canAskAgain: boolean } | null;
type Element = { type: unknown; props: Record<string, any> };

// Execute the actual scanner and its effects with camera/permission I/O replaced.
// This covers entry behavior, not native rendering, OS dialogs or physical scans.
function harness(initialPermission: Permission, requestResult: Exclude<Permission, null>) {
  const refs: Array<{ current: any }> = [];
  const effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
  let refIndex = 0, effectIndex = 0;
  let pending: Array<() => void> = [];
  let permission = initialPermission;
  let requests = 0, denied = 0, unavailable = 0;
  const decoded: string[] = [];
  const request = async () => { requests++; return requestResult; };
  const modules: Record<string, unknown> = {
    'react': {
      useRef(value: unknown) { const index = refIndex++; return refs[index] ??= { current: value }; },
      useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
        const index = effectIndex++, previous = effects[index];
        if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
          pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: effect() || undefined }; });
        }
      },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: Record<string, any>) => ({ type, props }), jsxs: (type: unknown, props: Record<string, any>) => ({ type, props }) },
    'react-native': { Pressable: 'Pressable', Text: 'Text', View: 'View', StyleSheet: { create: (value: unknown) => value } },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [permission, request] },
    '../packing-station/scan': { STATION_BARCODE_TYPES, normalizeStationReference },
    '../theme/ThemeProvider': { useTheme: () => ({ colors: { textPrimary: '#192A3E', scanText: '#fff', accent: '#1D68BD' } }) },
    '../ui/motion': { PulseOpacity: 'PulseOpacity' },
    '../experience/android-task-first': { ANDROID_TASK_FIRST_REBUILD: true },
    '../theme/tokens': { taskFirstTypography: { body: {}, button: {}, secondary: {} } },
  };
  const compiled = ts.transpileModule(readFileSync(new URL('../src/screens/BarcodeScanView.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} as { BarcodeScanView: (props: Record<string, any>) => Element } };
  new Function('require', 'module', 'exports', compiled)((id: string) => { assert.ok(id in modules, id); return modules[id]; }, loaded, loaded.exports);
  function render(nextPermission = permission, lockKey = 'scan') {
    permission = nextPermission; refIndex = 0; effectIndex = 0; pending = [];
    const tree = loaded.exports.BarcodeScanView({ lockKey, onDecoded: (value: string) => decoded.push(value), onCancel() {}, onPermissionDenied: () => { denied++; }, onUnavailable: () => { unavailable++; } });
    for (const effect of pending) effect();
    return tree;
  }
  return { render, decoded, counts: () => ({ requests, denied, unavailable }), unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

function find(tree: Element, type: string): Element | undefined {
  if (tree.type === type) return tree;
  for (const child of [tree.props.children].flat(Infinity)) {
    if (child && typeof child === 'object' && 'props' in child) {
      const result = find(child as Element, type);
      if (result) return result;
    }
  }
}

test('a denied scanner entry prompts once and immediately exposes manual fallback', async () => {
  const h = harness(null, { granted: false, canAskAgain: true });
  h.render(); await Promise.resolve();
  h.render({ granted: false, canAskAgain: true });
  h.render({ granted: false, canAskAgain: true });
  assert.deepEqual(h.counts(), { requests: 1, denied: 1, unavailable: 0 });
});

test('permanently denied permission does not open another OS prompt', () => {
  const h = harness({ granted: false, canAskAgain: false }, { granted: false, canAskAgain: false });
  h.render(); h.render();
  assert.deepEqual(h.counts(), { requests: 0, denied: 1, unavailable: 0 });
});

test('camera mount failure exposes fallback once instead of leaving an unusable scan view', () => {
  const h = harness({ granted: true, canAskAgain: true }, { granted: true, canAskAgain: true });
  const camera = find(h.render(), 'CameraView')!;
  camera.props.onMountError(); camera.props.onMountError();
  assert.deepEqual(h.counts(), { requests: 0, denied: 0, unavailable: 1 });
});

test('a scan only returns one normalized reference per explicit scanner entry', () => {
  const h = harness({ granted: true, canAskAgain: true }, { granted: true, canAskAgain: true });
  const camera = find(h.render(), 'CameraView')!;
  camera.props.onBarcodeScanned({ data: '  ORDER-123  ' });
  camera.props.onBarcodeScanned({ data: 'ORDER-999' });
  assert.deepEqual(h.decoded, ['ORDER-123']);
  find(h.render(undefined, 'next-entry'), 'CameraView')!.props.onBarcodeScanned({ data: 'ORDER-999' });
  assert.deepEqual(h.decoded, ['ORDER-123', 'ORDER-999']);
});

test('a late permission response cannot navigate an unmounted scanner', async () => {
  const h = harness(null, { granted: false, canAskAgain: true });
  h.render(); h.unmount(); await Promise.resolve();
  assert.deepEqual(h.counts(), { requests: 1, denied: 0, unavailable: 0 });
});
