// =============================================================================
// The hosted site only: puts the landing page at the root and the app at /app/. The desktop
// app and `npm run dev` never see this, because it runs after `npm run build`, on the site
// workflow. The built app uses root-absolute paths, so its index.html can simply move.
//
//   npm run build && node scripts/place-landing.mjs
//
// On GitHub Actions it also asks the release for its real installer files, so each download
// row goes straight to its file. Anything it cannot find falls back to the Releases page.
// =============================================================================
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = '/* @@INSTALLERS@@ */ {}';

const PATTERNS = {
  windows: /-setup\.exe$/i,
  'mac-arm': /aarch64\.dmg$/i,
  'mac-intel': /x64\.dmg$/i,
  linux: /\.AppImage$/i,
};

/** Each system's installer URL from a release's assets: { name, browser_download_url }. */
export function pickInstallers(assets) {
  const out = {};
  for (const [id, pattern] of Object.entries(PATTERNS)) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) out[id] = hit.browser_download_url;
  }
  return out;
}

/** Move the built app to dist/app/ and lay the landing page over the root. */
export function placeLanding({ dist, source, installers = {} }) {
  const page = join(dist, 'index.html');
  if (!existsSync(page)) throw new Error(`No built app at ${page}: run npm run build first`);
  if (existsSync(join(dist, 'app', 'index.html')))
    throw new Error('The landing page is already placed: run npm run build again first');
  mkdirSync(join(dist, 'app'), { recursive: true });
  renameSync(page, join(dist, 'app', 'index.html'));
  for (const name of readdirSync(source)) copyFileSync(join(source, name), join(dist, name));
  const js = join(dist, 'landing.js');
  const text = readFileSync(js, 'utf8');
  if (!text.includes(TOKEN)) throw new Error('landing.js has lost its installers placeholder');
  writeFileSync(
    js,
    text.replace(TOKEN, () => JSON.stringify(installers)),
  );
}

/** The installers of the release being published (a tag) or else the latest one. */
async function releaseInstallers() {
  const { GITHUB_ACTIONS, GITHUB_REPOSITORY, GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_TOKEN } =
    process.env;
  if (!GITHUB_ACTIONS) return {};
  const which = GITHUB_REF_TYPE === 'tag' ? `tags/${GITHUB_REF_NAME}` : 'latest';
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/${which}`, {
      headers: GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {},
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const found = pickInstallers((await res.json()).assets ?? []);
    const missing = Object.keys(PATTERNS).filter((id) => !found[id]);
    if (missing.length) console.warn(`place-landing: no installer for ${missing.join(', ')}`);
    return found;
  } catch (err) {
    console.warn(`place-landing: download rows go to the Releases page (${err.message})`);
    return {};
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  placeLanding({
    dist: join(ROOT, 'dist'),
    source: join(ROOT, 'landing'),
    installers: await releaseInstallers(),
  });
  console.log('place-landing: landing page at /, the app at /app/');
}
