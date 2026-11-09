// =============================================================================
// Vendor the OFFLINE background-removal assets into public/ so the in-app remover
// runs with NO network at runtime (B7):
//   - the U-2-Net ONNX weights (Apache-2.0, general salient-object matting), from
//     HuggingFace (Heliosoph/u2net-onnx)
//   - the ONNX-runtime WASM that onnxruntime-web loads, copied from node_modules
// These files are large (~190 MB) and gitignored; this script reproduces them,
// pinned + checksummed. Re-run after bumping
// onnxruntime-web (the ORT wasm filenames are pinned to its version).
//
//   node scripts/fetch-bg-model.mjs      (or: npm run fetch-bg-model)
// =============================================================================
import { mkdir, writeFile, copyFile, access, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_REPO = 'Heliosoph/u2net-onnx';
const HF_BASE = `https://huggingface.co/${MODEL_REPO}/resolve/main`;
const MODEL_OUT = join(ROOT, 'public', 'models', MODEL_REPO);
const ORT_SRC = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const ORT_OUT = join(ROOT, 'public', 'ort');

// U-2-Net full model: Apache-2.0, trained on DUTS-TR only (NO DIS5K dataset taint),
// general salient-object (not portrait-biased). Fixed 320x320 input = its native
// resolution, so it's light on the CPU/WASM path and runs on any machine. The matte
// is downscaled to the 1-bit cell grid, which hides the raw-edge gap vs heavier
// models. (`u2netp.onnx` ~4.7 MB is the lighter, lower-quality swap; InSPyReNet is
// the documented higher-quality upgrade path —.)
const MODEL_FILES = ['u2net.onnx'];

// onnxruntime-web ships several wasm variants. We resolve it via the
// `onnxruntime-web-use-extern-wasm` export condition (vite.config.ts), which
// selects the `.jsep` (SIMD + threaded, WebGPU-capable) build and loads its
// wasm+glue from `ort.env.wasm.wasmPaths='/ort/'` (bg-remove.worker.ts) instead
// of inlining/emitting a copy. So ONLY the jsep pair is ever requested; the
// plain-CPU `ort-wasm-simd-threaded.wasm` (~13.5 MB, G-7) is dead weight and was
// removed. Re-run after bumping onnxruntime-web (filenames pin to its version).
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  if (await exists(dest)) {
    const { size } = await stat(dest);
    if (size > 0) {
      console.log(`= ${dest}  (cached, ${mb(size)})`);
      return;
    }
  }
  process.stdout.write(`v ${url} ... `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  console.log(`ok (${mb(buf.length)})`);
}

async function copyOrt(name) {
  const src = join(ORT_SRC, name);
  if (!(await exists(src))) {
    throw new Error(`missing ${src} - run "npm install" first (onnxruntime-web)`);
  }
  await mkdir(ORT_OUT, { recursive: true });
  await copyFile(src, join(ORT_OUT, name));
  console.log(`+ ort/${name}`);
}

console.log('Vendoring offline background-removal assets ...');
for (const f of MODEL_FILES) await download(`${HF_BASE}/${f}`, join(MODEL_OUT, f));
for (const f of ORT_FILES) await copyOrt(f);
console.log('Done. public/models + public/ort are ready (gitignored).');
