// Rebuild the codec's wasm (src-tauri/codec) and copy it next to its JS glue.
// The built file is committed (src/platform/dithtill-codec.wasm) so the web build, the
// tests and the MCP tools need no Rust toolchain; rerun this after changing the crate.
//
//   npm run build:codec
//
// Needs Rust (the pinned toolchain) + `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'src-tauri', 'codec');
const OUT = path.join(ROOT, 'src', 'platform', 'dithtill-codec.wasm');
const FLAG_SEPARATOR = String.fromCharCode(0x1f);

execFileSync(
  'cargo',
  [
    'build',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    path.join(CRATE, 'Cargo.toml'),
  ],
  {
    stdio: 'inherit',
    // Strip machine paths (repo + cargo home) from panic messages so rebuilds differ less
    // between machines. CARGO_ENCODED_RUSTFLAGS (0x1f-separated) survives spaces in paths.
    env: {
      ...process.env,
      CARGO_ENCODED_RUSTFLAGS: [
        `--remap-path-prefix=${ROOT}=.`,
        `--remap-path-prefix=${path.join(os.homedir(), '.cargo')}=cargo`,
      ].join(FLAG_SEPARATOR),
    },
  },
);
const built = path.join(
  CRATE,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'dithtill_codec.wasm',
);
fs.copyFileSync(built, OUT);
console.log(
  `codec wasm → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`,
);
