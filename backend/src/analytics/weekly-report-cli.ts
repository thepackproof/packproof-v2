import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { buildWeeklyReport, programInputJsonSchema, renderWeeklyReport } from "./program-metrics.js";

const HELP = `PackProof weekly decision report (local input; no network or billing side effects)
Usage: npx tsx src/analytics/weekly-report-cli.ts --input observations.json [--json report.json] [--markdown report.md]
       npx tsx src/analytics/weekly-report-cli.ts --schema
Times are UTC ISO timestamps; intervals end exclusively. Synthetic input stays labeled synthetic.
Without an output option, the JSON report is written to stdout. Maximum input size: 32 MiB.
`;

export async function runWeeklyReportCli(args: readonly string[], stdout: (value: string) => void = value => process.stdout.write(value)): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { stdout(HELP); return; }
  if (args.length === 1 && args[0] === "--schema") { stdout(`${JSON.stringify(programInputJsonSchema(), null, 2)}\n`); return; }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]; const value = args[index + 1];
    if (!["--input", "--json", "--markdown"].includes(flag) || !value || value.startsWith("--") || options.has(flag)) throw new Error("INVALID_CLI_ARGUMENTS");
    options.set(flag, value);
  }
  const inputPath = options.get("--input");
  if (!inputPath) throw new Error("INPUT_PATH_REQUIRED");
  const outputs = [options.get("--json"), options.get("--markdown")].filter((value): value is string => !!value);
  if (new Set([inputPath, ...outputs].map(path => resolve(path))).size !== outputs.length + 1) throw new Error("OUTPUT_PATH_CONFLICT");
  if ((await stat(inputPath)).size > 32 * 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
  const raw = await readFile(inputPath, "utf8");
  if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error("INPUT_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("INVALID_INPUT_JSON"); }
  const report = buildWeeklyReport(value);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  // Write only after full validation, and create reports with owner-only access.
  if (options.has("--json")) await writeFile(options.get("--json")!, json, { mode: 0o600 });
  if (options.has("--markdown")) await writeFile(options.get("--markdown")!, renderWeeklyReport(report), { mode: 0o600 });
  if (outputs.length === 0) stdout(json);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runWeeklyReportCli(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && /^[A-Z_]+(?::[A-Za-z.]+)?$/.test(error.message) ? error.message : "REPORT_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
