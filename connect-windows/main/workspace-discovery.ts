import type {SourceRole} from '../ui/workspace-types';

interface DiscoveryBridge {
  request(operation: string, payload?: unknown): Promise<unknown>;
}
interface DiscoveredFolder {
  folder: string;
  kind: 'discovered';
  label: string;
  evidence: string;
  sampleFile: string;
}

export async function discoverWorkspaceFolders(
  role: SourceRole,
  options: {exclude: readonly string[]},
  bridge: DiscoveryBridge,
): Promise<DiscoveredFolder[]> {
  const result = await bridge.request('discoverWorkspaceFolders', {role, exclude: options.exclude});
  if (!Array.isArray(result) || result.length > 8) throw Error('The folder check could not be completed.');
  const sampleExtension = role === 'evidence' ? /\.(csv|tsv|psv|jpg|jpeg|png|pdf)$/i : /\.(csv|tsv|psv)$/i;
  return result.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('kind' in item) || item.kind !== 'discovered' ||
        !('folder' in item) || typeof item.folder !== 'string' || !/^[A-Za-z]:\\/.test(item.folder) ||
        !('label' in item) || typeof item.label !== 'string' ||
        !('evidence' in item) || typeof item.evidence !== 'string' ||
        !('sampleFile' in item) || typeof item.sampleFile !== 'string' ||
        !/^[^\x00-\x1f<>:"/\\|?*]{1,255}$/.test(item.sampleFile) || !sampleExtension.test(item.sampleFile))
      throw Error('The folder check returned an unexpected result.');
    return {folder: item.folder, kind: 'discovered', label: item.label, evidence: item.evidence, sampleFile: item.sampleFile};
  });
}
