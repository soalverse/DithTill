// THE DETERMINISM LINT (v12,'s `verify` gate — landed with P6). The
// deterministic loop pipe (features → events → render → export) must be a pure
// function of its stored inputs: no wall clock, no ambient randomness, no rAF,
// and the export must NEVER touch the live audio engine (the live/deterministic
// split is the whole design). A source-scan suite (not an eslint plugin) so the
// import ban can see across files and the rule set lives next to its reasons.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/** Every module on the deterministic loop path (core math + the export walk). */
const DETERMINISTIC_MODULES = [
  'core/fft.ts',
  'core/audio-features.ts',
  'core/loop-audio.ts',
  'core/loop-events.ts',
  'core/modulators.ts',
  'core/loop-render.ts',
  'core/seeded-rng.ts',
  'core/video-frames.ts',
  'core/video-decode.ts',
  'core/visualizer.ts',
  'core/cell-style.ts',
  'core/scene-resolver.ts',
  'core/print-screen.ts',
  'core/layer-fx.ts',
  'core/layer-trail.ts',
  'core/canvas-fx.ts',
  'platform/loop-export.ts',
];

/** Ambient-nondeterminism tokens. Any hit = the preview can silently diverge
 *  from the export (or two exports from each other). */
const BANNED = [
  /\bMath\.random\b/,
  /\bDate\.now\b/,
  /\bperformance\.now\b/,
  /\brequestAnimationFrame\b/,
  /\bnew Date\s*\(/,
];

const strippedSource = (rel: string): string => {
  const raw = readFileSync(join(SRC, rel), 'utf8');
  // Strip comments so prose ("never Date.now") can't trip the token scan.
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
};

describe('determinism lint', () => {
  for (const rel of DETERMINISTIC_MODULES) {
    it(`${rel} has no wall clock / ambient randomness / rAF`, () => {
      const code = strippedSource(rel);
      for (const re of BANNED) {
        expect(re.test(code), `${rel} matches banned pattern ${re}`).toBe(false);
      }
    });
  }

  it('loop-export never imports the live audio engine', () => {
    const code = strippedSource('platform/loop-export.ts');
    expect(/audio-engine/.test(code)).toBe(false);
  });

  it('the deterministic core never imports from ui/', () => {
    for (const rel of DETERMINISTIC_MODULES) {
      const code = strippedSource(rel);
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      const uiImports = imports.filter((p) => /(^|\/)ui\//.test(p));
      expect(uiImports, `${rel} imports ${uiImports.join(', ')}`).toEqual([]);
    }
  });
});
