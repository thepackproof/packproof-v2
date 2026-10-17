import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureFeedbackGate, emitCaptureSafeFeedback } from '../src/theme/capture-feedback.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('capture silences all feedback until the recording promise settles', async () => {
  const gate = createCaptureFeedbackGate();
  const release = gate.silence();
  let emitted = 0, prepared = 0;
  const prepare = async () => { prepared++; return true; };
  const emit = async () => { emitted++; };
  await emitCaptureSafeFeedback(prepare, emit, gate);
  assert.equal(prepared, 0);
  assert.equal(emitted, 0);
  release();
  await emitCaptureSafeFeedback(prepare, emit, gate);
  assert.equal(emitted, 1);
});

test('late system feedback cannot vibrate after recording begins', async () => {
  const gate = createCaptureFeedbackGate();
  let ready!: (value: boolean) => void;
  let emitted = false;
  const pending = emitCaptureSafeFeedback(() => new Promise<boolean>(r => { ready = r; }), async () => { emitted = true; }, gate);
  const release = gate.silence();
  ready(true);
  await pending;
  assert.equal(emitted, false);
  release();
});

test('an obsolete press does not replay after a short recording finishes', async () => {
  const gate = createCaptureFeedbackGate();
  let ready!: (value: boolean) => void;
  let emitted = false;
  const pending = emitCaptureSafeFeedback(() => new Promise<boolean>(r => { ready = r; }), async () => { emitted = true; }, gate);
  gate.silence()();
  ready(true);
  await pending;
  assert.equal(emitted, false);
});

test('overlapping ownership and repeated cleanup cannot enable feedback early', () => {
  const gate = createCaptureFeedbackGate();
  const a = gate.silence(), b = gate.silence();
  a(); a();
  assert.equal(gate.permit()(), false);
  b();
  assert.equal(gate.permit()(), true);
});

// Execute the real CameraSession.start callback with camera and UI ports. This
// checks wiring and promise lifetime; it does not replace physical-camera tests.
function cameraStart(ports: Record<string, unknown>) {
  const source = ts.createSourceFile('host.tsx', readFileSync(new URL('../src/ui/NativeCaptureHost.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let callback = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'start') callback = node.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(callback);
  return new Function(...Object.keys(ports), ts.transpileModule(callback + '\nreturn start;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(...Object.values(ports)) as () => Promise<void>;
}
for (const fail of [false, true]) test(`real recorder ${fail ? 'failure' : 'completion'} releases silence only after the camera settles`, async () => {
  const gate = createCaptureFeedbackGate();
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
  const pending = new Promise((a,b) => { resolve=a; reject=b; });
  const errors: unknown[] = [], captures: unknown[] = [], vibrations: string[] = [];
  const ref = <T>(current:T) => ({current});
  const noop = () => undefined;
  const start = cameraStart({
    useUnified:true, unifiedCamera:ref({startRecording:()=>pending}), camera:ref(null), ready:true,
    recordingRef:ref(false), request:{captureSessionId:'session-A',onRecordingStopped:noop,onRecordingInterrupted:noop},
    setError:(error:unknown)=>errors.push(error), bookmarks:ref([]), interrupted:ref(false), stopRequested:ref(false),
    started:ref(0), setRecording:noop, setSaving:noop, captureFeedbackGate:gate,
    haptic:async(kind:string)=>emitCaptureSafeFeedback(async()=>kind,async value=>{vibrations.push(value);},gate),
    onFinish:(capture:unknown)=>captures.push(capture),
  });
  const running=start();
  assert.equal(gate.permit()(),false);
  await emitCaptureSafeFeedback(async()=>true,async()=>{vibrations.push('unrelated button');},gate);
  if(fail)reject(new Error('Camera storage failure'));
  else resolve({uri:'file:///test-video.mp4',durationMs:1200,byteSize:100,contentType:'video/mp4'});
  await running;
  assert.equal(gate.permit()(),true);
  assert.deepEqual(vibrations,[]);
  assert.equal(captures.length,fail?0:1);
  if(fail)assert.ok(errors.includes('Camera storage failure'));
});
