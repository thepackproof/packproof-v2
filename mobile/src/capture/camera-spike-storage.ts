import * as FileSystem from "expo-file-system";
import type { SpikeReport } from "./camera-spike-model";

// These files never enter the production evidence queue or acquire a Proof identity.
export function spikeDirectory(sessionId?: string): string {
  if (!FileSystem.documentDirectory) throw new Error("Local storage is unavailable.");
  if (sessionId && !/^[a-zA-Z0-9_-]{1,80}$/.test(sessionId)) throw new Error("Invalid test session.");
  return `${FileSystem.documentDirectory}packproof-camera-spike/${sessionId ? `${sessionId}/` : ""}`;
}

let writes: Promise<void> = Promise.resolve();
export function saveSpikeReport(report: SpikeReport): Promise<void> {
  // Snapshot before queueing: a later callback must not mutate an earlier write.
  const contents = JSON.stringify(report, null, 2);
  const directory = spikeDirectory(report.sessionId);
  const next = writes.catch(() => undefined).then(async () => {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.writeAsStringAsync(`${directory}report.next.json`, contents);
    await FileSystem.moveAsync({ from: `${directory}report.next.json`, to: `${directory}report.json` });
  });
  writes = next;
  return next;
}

export interface SavedSpike {
  sessionId: string;
  report: SpikeReport | null;
  reportUri: string | null;
  videoUri: string | null;
  recoveryWarning: boolean;
}

export async function listSavedSpikes(): Promise<SavedSpike[]> {
  const directory = spikeDirectory();
  if (!(await FileSystem.getInfoAsync(directory)).exists) return [];
  const ids = (await FileSystem.readDirectoryAsync(directory))
    .filter((id) => /^[a-zA-Z0-9_-]{1,80}$/.test(id)).sort().reverse().slice(0,20);
  const saved: SavedSpike[] = [];
  for (const sessionId of ids) {
    const path = spikeDirectory(sessionId);
    let report: SpikeReport | null = null;
    let reportUri: string | null = null;
    // A complete next file can be newer than the last atomic rename after a crash.
    for (const name of ["report.next.json", "report.json"]) {
      try {
        const info = await FileSystem.getInfoAsync(`${path}${name}`);
        if (!info.exists || info.isDirectory || info.size > 100_000) continue;
        const candidate = JSON.parse(await FileSystem.readAsStringAsync(`${path}${name}`));
        if (candidate.source === "CAMERA_SPIKE" && candidate.sessionId === sessionId && Array.isArray(candidate.events)) {
          report = candidate;
          reportUri = `${path}${name}`;
          break;
        }
      } catch { /* A process interruption may leave a partial journal; retain the movie. */ }
    }
    const videoUri = `${path}video.mp4`;
    const video = await FileSystem.getInfoAsync(videoUri);
    const hasVideo = video.exists && !video.isDirectory && video.size > 0;
    if (!report && !hasVideo) continue;
    saved.push({sessionId, report, reportUri, videoUri: hasVideo ? videoUri : null,
      recoveryWarning: !report?.recording || report.active || Boolean(report.interrupted)});
  }
  return saved;
}
