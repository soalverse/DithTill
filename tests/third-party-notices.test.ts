// THIRD-PARTY-NOTICES.md is generated from the lockfiles: a dependency change must
// regenerate it (npm run notices), and the permissive-deps rule is checked by the generator.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error a plain node script, with no types
import { spdxSatisfied } from '../scripts/gen-third-party-notices.mjs';
import { CREDITS } from '../src/ui/shell-theme';

const ROOT = join(__dirname, '..');
const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('THIRD-PARTY-NOTICES.md', () => {
  it('was generated from the current lockfiles (else: npm run notices)', () => {
    for (const f of ['package-lock.json', 'src-tauri/Cargo.lock', 'src-tauri/codec/Cargo.lock']) {
      const body = readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
      const hash = createHash('sha256').update(body).digest('hex');
      expect(notices.split('\n')[0]).toContain(`${f} sha256:${hash}`);
    }
  });

  it('names every direct dependency of the app', () => {
    for (const name of Object.keys(pkg.dependencies)) {
      expect(notices).toContain(`\n| ${name} | `);
    }
  });

  it('credits the MPL exception with a link to the source, and what no lockfile knows', () => {
    const section = notices.slice(
      notices.indexOf('## The one exception'),
      notices.indexOf('## What is not in the app'),
    );
    for (const name of ['cssparser', 'cssparser-macros', 'selectors', 'dtoa-short', 'option-ext']) {
      expect(section).toMatch(new RegExp(`\\| ${name} \\| [^|]+ \\| MPL-2.0 \\| https://`));
    }
    expect(notices).toContain('U-2-Net');
    expect(notices).toContain('SIL Open Font License');
  });

  it('carries no local paths', () => {
    expect(notices).not.toMatch(/[A-Za-z]:[\\/]Users|\/home\/|\.cargo[\\/]/);
  });
});

describe('the licence rule the generator enforces', () => {
  const ok = (id: string) => id === 'MIT' || id === 'Apache-2.0';
  it('reads SPDX expressions', () => {
    expect(spdxSatisfied('MIT', ok)).toBe(true);
    expect(spdxSatisfied('MIT OR GPL-3.0-only', ok)).toBe(true);
    expect(spdxSatisfied('(MIT OR Apache-2.0) AND Zlib', ok)).toBe(false);
    expect(spdxSatisfied('GPL-3.0-only', ok)).toBe(false);
    expect(spdxSatisfied('', ok)).toBe(false);
  });
});

describe('Credits & licences', () => {
  it('states the licence and points at the notices file', () => {
    expect(CREDITS.byline).toBe('DithTill by Soalverse · Apache-2.0');
    expect(CREDITS.rest).toContain('THIRD-PARTY-NOTICES.md');
  });
});
