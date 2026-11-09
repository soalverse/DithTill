// =============================================================================
// Writes THIRD-PARTY-NOTICES.md from the lockfiles: every package that
// ships in the app (npm production deps, plus both Rust crates' normal + build deps,
// for every platform), its licence, a link to its source, and its licence text.
// Fails if a package's licence breaks the permissive-deps rule (CLAUDE.md), so a bad
// dependency stops here. Needs `npm install` and a cargo that can read the registry.
// The lockfile hashes in the header let tests/third-party-notices.test.ts catch a
// stale file.
//
//   node scripts/gen-third-party-notices.mjs      (or: npm run notices)
// =============================================================================
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const LOCKFILES = ['package-lock.json', 'src-tauri/Cargo.lock', 'src-tauri/codec/Cargo.lock'];

// The permissive family. MPL-2.0 is the ONE named exception, and only for these packages.
const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'Zlib',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BSL-1.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
]);
const MPL_ALLOWED = new Set([
  'cssparser',
  'cssparser-macros',
  'selectors',
  'dtoa-short',
  'option-ext',
]);

// npm marks these as production deps, but they are types only: nothing of them ships.
const TYPES_ONLY = (name) =>
  name.startsWith('@types/') || ['csstype', 'undici-types'].includes(name);

// Packages that ship no licence file: the copyright line their licence text carries.
const COPYRIGHT_OVERRIDE = {
  'onnxruntime-web': 'Copyright (c) Microsoft Corporation',
  'onnxruntime-common': 'Copyright (c) Microsoft Corporation',
};

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

// The few packages under another licence that ship no text of it: named here, with their source.
const BARE_TEXT =
  'These packages ship no licence file of their own. Their licence is named beside each one, and its text is at their source.';

/** True when an SPDX expression can be satisfied by `ok` licences (AND = all, OR = any). */
export function spdxSatisfied(expr, ok) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const atom = () => {
    if (tokens[i] === '(') {
      i++;
      const v = or();
      i++; // ')'
      return v;
    }
    let id = tokens[i++];
    if (tokens[i] === 'WITH') {
      id += ` WITH ${tokens[i + 1]}`;
      i += 2;
    }
    return ok(id);
  };
  const and = () => {
    let v = atom();
    while (tokens[i] === 'AND') {
      i++;
      const r = atom();
      v = v && r;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === 'OR') {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  return tokens.length > 0 && or();
}

const norm = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
const sourceLink = (repo, fallback) => {
  const raw = typeof repo === 'string' ? repo : repo?.url;
  if (!raw) return fallback;
  const gh = raw.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (gh) return `https://github.com/${gh[1]}`;
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
};
const LICENCE_FILE = /^(licen[sc]e|copying|unlicense|copyright)([-_.].*)?$/i;
function licenceFilesIn(dir) {
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => norm(readFileSync(join(dir, f), 'utf8')))
    .filter(Boolean);
}

// ---- npm: everything the lockfile doesn't mark dev-only (except type-only packages) --------
function npmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || entry.dev) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (TYPES_ONLY(name)) continue;
    const dir = join(ROOT, key);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const author = typeof meta.author === 'string' ? meta.author : meta.author?.name;
    out.push({
      name,
      version: entry.version,
      license: entry.license ?? meta.license ?? '',
      source: sourceLink(meta.repository, `https://www.npmjs.com/package/${name}`),
      authors: author ? [author] : [],
      texts: licenceFilesIn(dir),
    });
  }
  return out;
}

// ---- Rust: walk each crate's resolve graph from its root (normal + build deps, no dev) -----
function cratePackages(manifest) {
  const r = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', join(ROOT, manifest)],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) throw new Error(`cargo metadata failed for ${manifest}:\n${r.stderr}`);
  const meta = JSON.parse(r.stdout);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = [meta.resolve.root];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some((k) => k.kind !== 'dev')) stack.push(dep.pkg);
    }
  }
  const out = [];
  for (const id of seen) {
    const p = byId.get(id);
    if (!p.source) continue; // our own crates
    // A workspace member (FilmCraft) keeps its licence files at the workspace root.
    let dir = dirname(p.manifest_path);
    let texts = licenceFilesIn(dir);
    const checkout = join(homedir(), '.cargo', 'git', 'checkouts') + sep;
    while (!texts.length && dir.startsWith(checkout) && dirname(dir) !== checkout) {
      dir = dirname(dir);
      texts = licenceFilesIn(dir);
    }
    out.push({
      name: p.name,
      version: p.version,
      license: p.license ?? '',
      source:
        p.repository ??
        (p.source.startsWith('git+')
          ? p.source.slice(4).split(/[?#]/)[0]
          : `https://crates.io/crates/${p.name}`),
      authors: p.authors.map((a) => a.replace(/\s*<[^>]*>/, '')),
      texts,
    });
  }
  return out;
}

function collect() {
  const all = new Map();
  for (const p of [
    ...npmPackages(),
    ...cratePackages('src-tauri/Cargo.toml'),
    ...cratePackages('src-tauri/codec/Cargo.toml'),
  ]) {
    all.set(`${p.name}@${p.version}`, p);
  }
  return [...all.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  );
}

function checkLicences(pkgs) {
  const bad = pkgs.filter(
    (p) =>
      !spdxSatisfied(
        p.license.replace(/\//g, ' OR '),
        (id) => PERMISSIVE.has(id) || (id === 'MPL-2.0' && MPL_ALLOWED.has(p.name)),
      ),
  );
  if (bad.length) {
    const rows = bad.map((p) => `  ${p.name} ${p.version}: ${p.license || '(no licence field)'}`);
    throw new Error(`Licences outside the permissive-deps rule:\n${rows.join('\n')}`);
  }
}

/** The licence texts, one entry per distinct text, each with the packages it covers. */
function groupTexts(pkgs) {
  const groups = new Map();
  const add = (text, label) => {
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(label);
  };
  for (const p of pkgs) {
    const label = `${p.name} ${p.version}`;
    if (p.texts.length) {
      for (const t of p.texts) add(t, label);
      continue;
    }
    // No licence file in the package: the standard text, with its authors as the copyright.
    if (/\bMIT\b/.test(p.license)) {
      const holder =
        COPYRIGHT_OVERRIDE[p.name] ??
        `Copyright (c) ${p.authors.join(', ') || `the ${p.name} authors`}`;
      add(`MIT License\n\n${holder}\n\n${MIT_TEXT}`, label);
    } else if (/\bApache-2\.0\b/.test(p.license)) {
      add(norm(readFileSync(join(ROOT, 'LICENSE'), 'utf8')), label);
    } else {
      add(BARE_TEXT, `${label} (${p.license}, ${p.source})`);
    }
  }
  return [...groups.entries()]
    .map(([text, labels]) => ({ text, labels: [...new Set(labels)].sort() }))
    .sort((a, b) => a.labels[0].localeCompare(b.labels[0], 'en'));
}

const fence = (text) => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
};

function render(pkgs) {
  const hashes = LOCKFILES.map((f) => {
    const body = readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    return `${f} sha256:${createHash('sha256').update(body).digest('hex')}`;
  });
  const mpl = pkgs.filter((p) => p.license.includes('MPL-2.0'));
  const row = (p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.source} |`;
  const fonts = norm(readFileSync(join(ROOT, 'public/fonts/OFL.txt'), 'utf8'));
  const apache = norm(readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  return [
    `<!-- Generated by scripts/gen-third-party-notices.mjs. ${hashes.join(' · ')} -->`,
    '',
    '# Third-party notices',
    '',
    'DithTill stands on a lot of free shoulders, and this file names every one of them, with the licence each one came with. A script writes it from the lockfiles, so please do not edit it by hand, it will only write over you.',
    '',
    `That is ${pkgs.length} packages, plus the model and the fonts below, which no lockfile knows about.`,
    '',
    '## The model and the fonts',
    '',
    '### U-2-Net',
    '',
    'The Cut out button runs U-2-Net, by Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane and Martin Jagersand ("U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection", Pattern Recognition 2020). The weights are the official ONNX checkpoint, unchanged, under Apache-2.0.',
    '',
    '- Source: https://github.com/xuebinqin/U-2-Net',
    '- The copy DithTill fetches: https://huggingface.co/Heliosoph/u2net-onnx',
    '',
    fence(apache),
    '',
    '### Archivo, DM Mono and VT323',
    '',
    fence(fonts),
    '',
    '## The one exception',
    '',
    'These packages come with Tauri itself, under MPL-2.0. DithTill uses them unchanged, and their source is at these links.',
    '',
    '| Package | Version | Licence | Source |',
    '| --- | --- | --- | --- |',
    ...mpl.map(row),
    '',
    '## What is not in the app',
    '',
    'The tools that build and test DithTill are not in the installers, and neither are the packages the AI tools in `scripts/mcp` use. npm installs those on your own machine when you run them. One worth naming is sharp, which the AI tools use: it brings libvips under LGPL-3.0-or-later, from its own packages, and DithTill does not carry a copy.',
    '',
    'ONNX Runtime carries notices of its own for the code inside it: https://github.com/microsoft/onnxruntime/blob/main/ThirdPartyNotices.txt',
    '',
    '## Every package',
    '',
    '| Package | Version | Licence | Source |',
    '| --- | --- | --- | --- |',
    ...pkgs.map(row),
    '',
    '## The licence texts',
    '',
    'Each text once, with the packages it covers.',
    '',
    ...groupTexts(pkgs).flatMap(({ text, labels }) => [
      `### ${labels.join(', ')}`,
      '',
      fence(text),
      '',
    ]),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkgs = collect();
  checkLicences(pkgs);
  const md = render(pkgs);
  if (md.includes(homedir()) || md.includes(homedir().replace(/\\/g, '/'))) {
    throw new Error('A local path reached THIRD-PARTY-NOTICES.md');
  }
  if (!existsSync(dirname(OUT))) throw new Error(`No folder for ${OUT}`);
  writeFileSync(OUT, md, 'utf8');
  const noText = pkgs.filter((p) => !p.texts.length);
  console.log(
    `THIRD-PARTY-NOTICES.md: ${pkgs.length} packages, ${(md.length / 1024).toFixed(0)} KB, ` +
      `${noText.length} with no licence file (standard text used).`,
  );
  if (noText.length)
    console.log(noText.map((p) => `  ${p.name} ${p.version} [${p.license}]`).join('\n'));
}
