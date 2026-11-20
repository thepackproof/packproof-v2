import { win32 } from 'node:path';
import type { SourceRole, WorkspaceFolderSuggestion } from '../ui/workspace-types';

export interface FolderOption extends WorkspaceFolderSuggestion {
  sampleFile?: string;
}

const sameLocation = (folder: string) => win32.normalize(folder).toLowerCase();

export function distinctLocations(choices: FolderOption[]) {
  const seen = new Set<string>();
  return choices.filter(({ folder }) => {
    const path = sameLocation(folder);
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });
}

// Remember only the locations offered to this renderer. Revalidate their origin
// and current recognition before handing a selected folder to the service.
export class WorkspaceFolderOffers {
  private readonly byRole = new Map<SourceRole, FolderOption[]>();

  remember(role: SourceRole, choices: FolderOption[]) {
    this.byRole.set(role, choices);
    return choices.map(({sampleFile: _sample, ...publicChoice}) => publicChoice);
  }

  async confirm(
    role: SourceRole,
    folder: string,
    refresh: (scan: boolean) => Promise<FolderOption[]>,
  ): Promise<FolderOption> {
    const offered = this.byRole.get(role)?.find(choice => choice.folder === folder);
    if (offered) {
      const fresh = await refresh(offered.kind === 'discovered');
      const match = fresh.find(choice => choice.folder === folder && choice.kind === offered.kind && choice.label === offered.label);
      if (match) return match;
    }
    throw Error('That folder has changed. Find your records again or choose a folder.');
  }
}
