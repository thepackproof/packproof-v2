import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { newIdempotencyKey } from '../v2-api';
import { photoContextKey, replacePhotoSlot, type PhotoDraft, type PhotoDraftContext } from './photo-draft-model';

const prefix = 'packproof.photo-draft.v1:';
const hash = (value: string) => bytesToHex(sha256(utf8ToBytes(value)));
const accountPrefix = (api: string, user: string) => `${prefix}${hash(JSON.stringify([api.replace(/\/+$/, ''), user]))}:`;
const storageKey = (context: PhotoDraftContext) => `${accountPrefix(context.apiBaseUrl, context.userId)}${hash(photoContextKey(context))}`;
const locks = new Map<string, Promise<unknown>>();

export async function readPhotoDraft(context: PhotoDraftContext): Promise<PhotoDraft | null> {
  const raw = await AsyncStorage.getItem(storageKey(context));
  if (!raw) return null;
  const value = JSON.parse(raw) as PhotoDraft;
  if (value.schema !== 1 || photoContextKey(value) !== photoContextKey(context) || !Array.isArray(value.slots) || !Array.isArray(value.retainedUris))
    throw new Error('Saved photo details could not be read. Your originals have not been removed.');
  return value;
}
export async function listPhotoDrafts(api: string, user: string): Promise<PhotoDraft[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter(key => key.startsWith(accountPrefix(api, user)));
  const values = await AsyncStorage.multiGet(keys);
  return values.map(([, raw]) => {
    if (!raw) throw new Error('A saved photo draft is unavailable. Refresh before starting new photos.');
    const value = JSON.parse(raw) as PhotoDraft;
    if (value.schema !== 1 || value.userId !== user || value.apiBaseUrl !== api.replace(/\/+$/, '') || !Array.isArray(value.slots))
      throw new Error('Saved photo details could not be read. Originals remain on this device.');
    return value;
  });
}
export async function persistPhotoDraft(draft: PhotoDraft): Promise<void> {
  // AsyncStorage replaces a single native key atomically. Persist identifiers before sending bytes.
  await AsyncStorage.setItem(storageKey(draft), JSON.stringify(draft));
}
export async function retainPhoto(context: PhotoDraftContext, input: { slot: string; uri: string; contentType: string }): Promise<PhotoDraft> {
  const key = storageKey(context);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    if (!FileSystem.documentDirectory) throw new Error('Device storage is unavailable. Keep this photo open and try again.');
    const now = new Date().toISOString();
    const draft = await readPhotoDraft(context) ?? { ...context, schema: 1 as const, id: newIdempotencyKey(), actionKey: newIdempotencyKey(),
      updatedAt: now, phase: 'LOCAL_ONLY' as const, slots: [], retainedUris: [] };
    if (draft.phase !== 'LOCAL_ONLY') throw new Error('Resume the saved photo submission before taking another photo.');
    const directory = `${FileSystem.documentDirectory}photo-drafts/${hash(key)}/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const uploadKey = newIdempotencyKey();
    const uri = `${directory}${uploadKey}.image`;
    await FileSystem.copyAsync({ from: input.uri, to: uri });
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || !info.size) throw new Error('The photo could not be saved to device storage. Try again.');
    const next = replacePhotoSlot(draft, { ...input, uri, uploadKey }, now);
    await persistPhotoDraft(next);
    return next;
  });
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}
