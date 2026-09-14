import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = Platform.OS === 'ios'
  ? requireOptionalNativeModule<{
      previewDocument(uri: string, title: string | null): Promise<boolean>;
      cancelPreview(uri: string): Promise<boolean>;
    }>('PackProofDocumentPreview')
  : null;

/**
 * Keep the verified local PDF until this promise settles. True means the native
 * preview was presented and dismissed; it does not mean the document was signed.
 * False means this platform/build has no native preview. Native failures reject.
 */
export async function previewDocument(uri: string, title?: string): Promise<boolean> {
  if (!native) return false;
  return native.previewDocument(uri, title ?? null);
}

/** Cancel only this caller's PDF. Keep its file until previewDocument settles. */
export async function cancelDocumentPreview(uri: string): Promise<boolean> {
  if (!native) return false;
  return native.cancelPreview(uri);
}
