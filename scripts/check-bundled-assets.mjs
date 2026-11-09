// =============================================================================
// Clean-clone build guard (G-6). The bundled RUNTIME assets - the U-2-Net weights
// and the ONNX-runtime wasm - are gitignored (too large for git; reproduced by a
// fetch script). Before this guard, `tauri build` ran only `npm run build`, so a
// fresh clone silently shipped an app with NO background removal. (Video export
// needs no fetched asset since: the codec is compiled into the app and its
// wasm build is committed.) This script runs FIRST in beforeBuildCommand: it
// verifies every bundled asset is present, auto-runs the idempotent fetchers for
// anything missing, and FAILS LOUDLY (listing exactly what's missing + the exact
// fetch command) if it still can't produce them.
//
// Dev (`npm run dev`) does NOT run this - bg-removal lazy-loads, so the dev server
// has no hard dependency on these assets.
//
// Escape hatches:
//   DITHTILL_SKIP_ASSET_CHECK=1   skip entirely (mirrors DITHTILL_SKIP_VERIFY)
//   DITHTILL_NO_AUTOFETCH=1       check + fail loudly, but never auto-download
// =============================================================================
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const noAutofetch = process.env.DITHTILL_NO_AUTOFETCH === '1';

if (process.env.DITHTILL_SKIP_ASSET_CHECK === '1') {
  console.warn('check-bundled-assets: skipped (DITHTILL_SKIP_ASSET_CHECK=1).');
  process.exit(0);
}

/** A fetch command runnable from node, cross-platform. */
const fetchBgModel = {
  label: 'npm run fetch-bg-model',
  cmd: 'npm',
  args: ['run', 'fetch-bg-model'],
};
const nonEmpty = (p) => existsSync(p) && statSync(p).size > 0;

// Each group: the files that must all be present, and the fetcher that produces them.
const groups = [
  {
    name: 'background-removal weights + ONNX-runtime wasm',
    fetch: fetchBgModel,
    files: [
      join(ROOT, 'public', 'models', 'Heliosoph', 'u2net-onnx', 'u2net.onnx'),
      join(ROOT, 'public', 'ort', 'ort-wasm-simd-threaded.jsep.wasm'),
      join(ROOT, 'public', 'ort', 'ort-wasm-simd-threaded.jsep.mjs'),
    ],
    softFiles: [],
    unsupported: null,
  },
];

function runFetch(fetch) {
  if (fetch.winOnly && !isWin) return false;
  console.log(`\ncheck-bundled-assets: fetching via \`${fetch.cmd} ${fetch.args.join(' ')}\` ...`);
  const r = spawnSync(fetch.cmd, fetch.args, { cwd: ROOT, stdio: 'inherit', shell: isWin });
  return r.status === 0;
}

const missing = [];
const warnings = [];

for (const g of groups) {
  if (g.unsupported) {
    warnings.push(`- ${g.name}: ${g.unsupported}`);
    continue;
  }
  let absent = g.files.filter((f) => !nonEmpty(f));
  if (absent.length && !noAutofetch && !(g.fetch.winOnly && !isWin)) {
    runFetch(g.fetch);
    absent = g.files.filter((f) => !nonEmpty(f));
  }
  if (absent.length) {
    missing.push({ group: g, absent });
  } else {
    // Present: flag any soft (license) file that's missing without blocking.
    for (const s of g.softFiles) {
      if (!nonEmpty(s)) {
        warnings.push(
          `- ${g.name}: ${s} is missing (license not vendored). Re-run: ${g.fetch.label} -Force`,
        );
      }
    }
  }
}

for (const w of warnings) console.warn(`check-bundled-assets: WARNING\n${w}`);

if (missing.length) {
  const lines = [
    '',
    '============================================================================',
    ' BUILD BLOCKED - bundled runtime assets are missing (G-6).',
    ' These are gitignored (large binaries); reproduce them, then rebuild:',
    '============================================================================',
  ];
  for (const m of missing) {
    lines.push(`\n  ${m.group.name}:`);
    for (const f of m.absent) lines.push(`    MISSING  ${f}`);
    lines.push(`    FETCH    ${m.group.fetch.label}`);
  }
  lines.push('');
  lines.push('  (Set DITHTILL_SKIP_ASSET_CHECK=1 to bypass, or DITHTILL_NO_AUTOFETCH=1 to');
  lines.push('   disable auto-download and only report.)');
  lines.push('');
  console.error(lines.join('\n'));
  process.exit(1);
}

console.log('check-bundled-assets: all bundled runtime assets present.');
