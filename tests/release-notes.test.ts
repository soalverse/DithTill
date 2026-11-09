// A release's notes come from the CHANGELOG, and a wrong tag or an empty section stops the draft.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error a plain node script, with no types
import { changelogSection, releaseNotes } from '../scripts/release-notes.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2027-01-01

### Fixed

- A later line.

## [0.1.0] - 2026-12-01

### Added

- The first line.
`;

describe('changelogSection', () => {
  it('takes one version, and stops at the next heading', () => {
    expect(changelogSection(CHANGELOG, '0.2.0')).toBe('### Fixed\n\n- A later line.');
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe('### Added\n\n- The first line.');
  });

  it('fails on a missing or empty section', () => {
    expect(() => changelogSection(CHANGELOG, '9.9.9')).toThrow('no section');
    expect(() => changelogSection('## [1.0.0]\n\n## [0.9.0]\n- x', '1.0.0')).toThrow('empty');
  });
});

describe('releaseNotes', () => {
  const inputs = { changelog: CHANGELOG, packageVersion: '0.2.0', footer: 'See {tag}.' };

  it('joins the section and the footer, filling in the tag', () => {
    expect(releaseNotes('v0.2.0', inputs)).toBe('### Fixed\n\n- A later line.\n\nSee v0.2.0.\n');
  });

  it('fails when the tag and package.json disagree, or the tag is not a version', () => {
    expect(() => releaseNotes('v0.1.0', inputs)).toThrow('package.json says 0.2.0');
    expect(() => releaseNotes('nightly', inputs)).toThrow('not a version tag');
  });
});

describe('the real files', () => {
  const ROOT = join(__dirname, '..');
  it('the app, its package and the desktop config agree on the version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const tauri = JSON.parse(readFileSync(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
    expect(tauri.version).toBe(pkg.version);
  });
});
