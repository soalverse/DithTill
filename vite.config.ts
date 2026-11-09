import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

// Tauri expects a fixed dev port; see src-tauri/tauri.conf.json build.devUrl.
const host = process.env.TAURI_DEV_HOST;

// Dev-only: ONNX-runtime (via transformers.js, in the bg-remove worker) dynamically
// `import()`s its wasm glue (.mjs) from the vendored /ort/ dir. Vite would intercept
// that import with a `?import` transform and 404 it; this middleware serves the raw
// vendored file first so the module loads. No effect on the production build — the
// packaged Tauri app serves public/ statically, with no Vite transform in the way.
function serveOrtRaw(): Plugin {
  return {
    name: 'serve-ort-raw',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        if (path.startsWith('/ort/')) {
          const file = join(server.config.root, 'public', path);
          if (existsSync(file)) {
            res.setHeader(
              'Content-Type',
              path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
            );
            createReadStream(file).pipe(res);
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveOrtRaw()],
  // onnxruntime-web's default entry (ort.bundle.min.mjs) inlines a static
  // `new URL('ort-wasm-simd-threaded.jsep.wasm', import.meta.url)`, which Vite
  // resolves and EMITS as a ~26.8 MB duplicate into dist/assets — dead weight,
  // since the bg-remove worker loads the wasm from `/ort/` via wasmPaths (G-7).
  // ORT ships an `onnxruntime-web-use-extern-wasm` export condition that points
  // at ort.min.mjs, the "extern wasm" build with NO static wasm URL. Selecting it
  // here stops the emission with zero runtime change. The trailing entries are
  // Vite 7's defaultClientConditions — we prepend, not replace, so normal
  // resolution is untouched.
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
  },
  // Tauri pipes the Rust build output through this terminal; don't let Vite wipe it.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true, // fail loudly instead of drifting to 1421 (white-screen trap)
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  // The CPU dither mirror is an ES-module Web Worker that imports the shared
  // constants — bundling it through Vite keeps exactly one copy of the math.
  worker: { format: 'es' },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
