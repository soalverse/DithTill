// =============================================================================
// Prints a release's notes: that version's CHANGELOG section, then what every release
// page says (scripts/release-footer.md). The release workflow runs it on a version tag,
// and it fails rather than publish a draft with the wrong notes or the wrong version.
//
//   node scripts/release-notes.mjs v0.1.0
// =============================================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The text under `## [version]`, up to the next `## [` heading. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## ['));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md's section for ${version} is empty`);
  return body;
}

/** The whole release page, for a tag like `v0.1.0`. */
export function releaseNotes(tag, { changelog, packageVersion, footer }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${tag} is not a version tag`);
  const version = tag.slice(1);
  if (version !== packageVersion) {
    throw new Error(`The tag says ${version}, package.json says ${packageVersion}`);
  }
  return `${changelogSection(changelog, version)}\n\n${footer.replaceAll('{tag}', tag).trim()}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');
  process.stdout.write(
    releaseNotes(process.argv[2] ?? '', {
      changelog: read('CHANGELOG.md'),
      packageVersion: JSON.parse(read('package.json')).version,
      footer: read('scripts/release-footer.md'),
    }),
  );
}
