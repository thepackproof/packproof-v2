import { win32 } from "node:path";

/** Only the trusted native chooser supplies paths. The service independently
 * validates NTFS/link safety and reads these basenames from its approved folder. */
export function backfillFileNames(folder: string, selected: string[]): string[] {
  if (!/^[A-Za-z]:[\\/]/.test(folder) || selected.length < 1 || selected.length > 100) throw Error("Choose between one and 100 CSV files from this source's approved folder.");
  const approved = win32.resolve(folder).toLowerCase();
  const names = selected.map(path => {
    if (!/^[A-Za-z]:[\\/]/.test(path) || win32.dirname(win32.resolve(path)).toLowerCase() !== approved) throw Error("Choose historical reports only from this source's approved folder.");
    const name = win32.basename(path);
    if (!name || name.length > 255 || /[\\/:]/.test(name) || name.includes("..") || !/\.csv$/i.test(name)) throw Error("Choose completed CSV files from the approved source.");
    return name;
  });
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw Error("Choose each historical report once.");
  return names;
}
