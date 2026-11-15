// The radar's entry point: the snapshot in, the ranked board and the dashboard out.
//
// The grader runs it bare, with no arguments, in a container where the sealed
// snapshot is mounted at /input and the output goes to /output:
//
//   node /bot/main.ts
//
// so the input defaults to MAKEFUN_INPUT_DIR (or /input) and the output to
// MAKEFUN_OUTPUT_DIR (or /output), exactly like the kit's starter. Locally:
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// The command reads the snapshot the kit ships, fits the model from its live-token
// protocols, ranks every pre-token protocol the watchlist rule keeps, writes board.json
// and data.js, copies the dashboard and its screenshots to the output directory, and
// writes dossier.json last. It writes nothing anywhere else, fetches nothing, and takes
// no clock, no random number and no locale into its output: two runs over the same
// snapshot produce byte-identical files. The dashboard must be copied from the
// repository, never read from the output directory; main.ts refuses to write over a
// snapshot that lives under the output directory, and refuses to read a dashboard that
// lives there.
//
// The output is the entry the make.fun kit expects: board.json, data.js, dashboard/,
// screenshots/ and dossier.json, all under MAKEFUN_OUTPUT_DIR.

import { readFileSync, existsSync, mkdirSync, writeFileSync, cpSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';
import {
  parseSnapshot,
  buildRadar,
  boardIssue,
  dataScript,
  MODEL,
  MODEL_VERSION,
  type BoardRow,
  type RadarData,
  type Snapshot,
} from './lib/model.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
// The grader's contract (same as the kit's starter): input from MAKEFUN_INPUT_DIR
// (or /input) and output to MAKEFUN_OUTPUT_DIR (or /output). No argument is ever
// required: the grader runs `node /bot/main.ts` with no arguments at all, so a
// missing --input must fall back to the mounted input directory, never throw.
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DASHBOARD_DIR = join(ROOT, 'dashboard');
const SCREENSHOTS_DIR = join(ROOT, 'screenshots');

function findInput(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1] !== undefined) return args[i + 1];
    if (args[i]!.startsWith('--input=')) return args[i]!.slice('--input='.length);
  }
  return process.env.MAKEFUN_INPUT_DIR ?? '/input';
}

function readSnapshot(inputPath: string): { path: string; snapshot: Snapshot } {
  const candidates = [
    inputPath,
    join(inputPath, 'snapshot.json'),
    join(inputPath, 'input', 'snapshot.json'),
    join(inputPath, 'input.json'),
  ];
  const path = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (path === undefined) throw new Error(`snapshot not found: tried ${candidates.join(', ')}`);
  return { path, snapshot: parseSnapshot(readFileSync(path, 'utf8')) };
}

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function formatUsd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function report(snapshot: Snapshot, board: BoardRow[], radar: RadarData): void {
  console.log(`model: ${MODEL_VERSION}, log(mcap) = ${radar.fit.intercept.toFixed(4)} + ${radar.fit.slope.toFixed(4)} * log(tvl), fitted on ${radar.fit.live_n} live-token protocols`);
  console.log(`blind 5-fold test: median |log error| ${radar.fit.validation.median_abs_log_error}, ${Math.round(radar.fit.validation.within_2x * 100)}% within 2x of the market cap, against a flat 0.25x TVL baseline of ${radar.fit.validation.baseline_median_abs_log_error} and ${Math.round(radar.fit.validation.baseline_within_2x * 100)}%`);
  console.log(`watchlist: ${radar.watchlist_size} slugs, all on the board; board: ${radar.board_size} rows (${radar.early_size} early rows below the watchlist floor of ${formatUsd(snapshot.floor_usd)}); live-token reference: ${radar.live_size} protocols`);
  for (const row of board.slice(0, 5)) {
    console.log(`  #${row.rank} ${row.name} (${row.slug}): implied ${formatUsd(row.implied_value_usd)}, TVL ${formatUsd(row.tvl_usd)}, ${row.category ?? 'no category'}, ${row.chains.join(', ') || 'no chain'}`);
  }
}

async function main(): Promise<void> {
  const input = findInput(process.argv.slice(2));
  const out = resolve(OUT);
  if (resolve(input).startsWith(out)) throw new Error('refusing to read the snapshot from under the output directory');

  const { path: snapshotPath, snapshot } = readSnapshot(input);
  console.log(`reading the snapshot from ${relative(process.cwd(), resolve(snapshotPath))} (as of ${snapshot.as_of}, ${snapshot.protocols.length} protocols)`);

  const { board, radar } = buildRadar(snapshot, MODEL);

  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new Error(`board is not one the gate will take: ${issue}`);
  if (board.length < 100) throw new Error(`board has ${board.length} rows, fewer than the gate's minimum of 100`);

  mkdirSync(out, { recursive: true });
  write(join(out, 'board.json'), toJson({ rows: board }));
  write(join(out, 'data.js'), dataScript(radar));

  if (!existsSync(DASHBOARD_DIR)) throw new Error(`dashboard not found at ${DASHBOARD_DIR}`);
  if (!existsSync(SCREENSHOTS_DIR)) throw new Error(`screenshots not found at ${SCREENSHOTS_DIR}`);
  const screenshotFiles = ['1-board.png', '2-detail.png', '3-filtered.png'];
  for (const name of screenshotFiles) {
    if (!existsSync(join(SCREENSHOTS_DIR, name))) throw new Error(`screenshot ${name} not found under ${SCREENSHOTS_DIR}`);
  }
  cpSync(DASHBOARD_DIR, join(out, 'dashboard'), { recursive: true });
  cpSync(SCREENSHOTS_DIR, join(out, 'screenshots'), { recursive: true });

  // dossier.json is written last, from the bytes the vendor's own function returns:
  // the scorer reruns the same code and demands the dossier it writes to match byte
  // for byte, so the file is exactly what buildDossier returns, nothing re-encoded.
  const dossierBytes = await buildDossier(out, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(out, 'dossier.json'), dossierBytes);

  report(snapshot, board, radar);
  console.log(`wrote board.json (${board.length} rows), data.js, dashboard/, screenshots/ and dossier.json to ${out}`);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
