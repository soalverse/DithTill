// =============================================================================
// Dot-matrix text: the alphabet's shape rules, the layout (one dot = one
// cell, Size spreads the dots, Spacing / Align / line breaks), and the text layer's
// raster following its config through edits, undo and duplicates.
// =============================================================================
import { describe, expect, it } from 'vitest';
import {
  DOT_FONT_CHARS,
  GLYPH_H,
  GLYPH_W,
  TEXT_DEFAULT,
  TEXT_MAX_CHARS,
  glyphRows,
  normalizeText,
  renderTextRaster,
  type TextLayerConfig,
} from '../src/core/dot-font';
import { useSceneStore } from '../src/state/scene-store';
import { getAssetCache } from '../src/ui/scene-assets';
import { addTextLayer, newTextAssetId, syncTextAssets } from '../src/ui/text-node';
import { duplicateSelection } from '../src/ui/paint-node';
import { beginGesture, endGesture } from '../src/state/gesture';

const cfg = (patch: Partial<TextLayerConfig>): TextLayerConfig => ({
  ...TEXT_DEFAULT,
  ...patch,
});

/** The lit cells of a raster as "x,y" strings. */
function dots(r: { w: number; covered: Uint8Array }): string[] {
  const out: string[] = [];
  r.covered.forEach((c, i) => {
    if (c) out.push(`${i % r.w},${Math.floor(i / r.w)}`);
  });
  return out;
}

describe('the dot alphabet', () => {
  it('covers A–Z, a–z, 0–9 and the agreed punctuation', () => {
    const want =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?\'"-:/&@#%+=()';
    for (const ch of want) expect(DOT_FONT_CHARS.includes(ch), ch).toBe(true);
  });

  it('every glyph is 5 dots wide, fits the 9-row cell, and only capitals-height unless it descends', () => {
    for (const ch of DOT_FONT_CHARS) {
      const rows = glyphRows(ch);
      expect(rows.length, ch).toBeLessThanOrEqual(GLYPH_H);
      for (const row of rows) expect(row, ch).toMatch(/^[#.]{5}$/);
      if (ch !== ' ') expect(rows.join('').includes('#'), ch).toBe(true);
    }
    // Descenders are the only glyphs that reach below the baseline (row 6).
    const descenders = [...DOT_FONT_CHARS].filter((ch) => glyphRows(ch).length > 7).sort();
    expect(descenders.join('')).toBe(',gjpqy');
  });
});

describe('text layout', () => {
  it('one dot = one cell at Size 1: "I" is the glyph itself', () => {
    const r = renderTextRaster(cfg({ text: 'I', size: 1 }));
    expect([r.w, r.h]).toEqual([GLYPH_W, GLYPH_H]);
    const rows = glyphRows('I');
    for (let y = 0; y < GLYPH_H; y++)
      for (let x = 0; x < GLYPH_W; x++)
        expect(r.covered[y * r.w + x], `${x},${y}`).toBe(rows[y]?.[x] === '#' ? 1 : 0);
    expect(r.tones.every((t, i) => (r.covered[i] ? t === 255 : t === 0))).toBe(true);
  });

  it('a bigger Size spreads the SAME dots apart (never grows them)', () => {
    const one = renderTextRaster(cfg({ text: 'Hi', size: 1 }));
    const three = renderTextRaster(cfg({ text: 'Hi', size: 3 }));
    expect(three.w).toBe((one.w - 1) * 3 + 1);
    expect(three.h).toBe((one.h - 1) * 3 + 1);
    const spread = dots(one).map((d) => {
      const [x, y] = d.split(',').map(Number);
      return `${x * 3},${y * 3}`;
    });
    expect(dots(three)).toEqual(spread);
  });

  it('Spacing adds empty dot columns between letters', () => {
    const tight = renderTextRaster(cfg({ text: 'AB', size: 1, spacing: 0 }));
    const wide = renderTextRaster(cfg({ text: 'AB', size: 1, spacing: 3 }));
    expect(tight.w).toBe(10);
    expect(wide.w).toBe(13);
  });

  it('line breaks stack lines; Align lines them up left, centre or right', () => {
    const at = (align: TextLayerConfig['align']) =>
      renderTextRaster(cfg({ text: 'III\nI', size: 1, spacing: 1, align }));
    const left = at('left');
    expect(left.w).toBe(17); // 3 letters: 3·5 + 2 gaps
    expect(left.h).toBe(GLYPH_H * 2 + 1);
    // The second line's "I" top bar starts at x = 1 (left), 7 (centre), 13 (right).
    const firstLit = (r: typeof left) => {
      const y = GLYPH_H + 1;
      for (let x = 0; x < r.w; x++) if (r.covered[y * r.w + x]) return x;
      return -1;
    };
    expect(firstLit(left)).toBe(1);
    expect(firstLit(at('center'))).toBe(7);
    expect(firstLit(at('right'))).toBe(13);
  });

  it('unknown characters are blanks of the same width; empty text is one clear cell', () => {
    const known = renderTextRaster(cfg({ text: 'A A', size: 1 }));
    const unknown = renderTextRaster(cfg({ text: 'A☃A', size: 1 }));
    expect(unknown.w).toBe(known.w);
    expect(dots(unknown)).toEqual(dots(known));
    const empty = renderTextRaster(cfg({ text: '', size: 4 }));
    expect([empty.w, empty.h]).toEqual([1, (GLYPH_H - 1) * 4 + 1]);
    expect(dots(empty)).toEqual([]);
  });

  it('normalises Size / Spacing / length / line endings', () => {
    const n = normalizeText({
      text: 'a\r\nb' + 'x'.repeat(TEXT_MAX_CHARS),
      size: 99,
      spacing: -2,
      align: 'sideways' as never,
    });
    expect(n.text.startsWith('a\nb')).toBe(true);
    expect(n.text.length).toBe(TEXT_MAX_CHARS);
    expect([n.size, n.spacing, n.align]).toEqual([10, 0, 'center']);
  });
});

describe('the text layer', () => {
  it('its dots follow its config through edits and undo, and a duplicate gets its own slot', () => {
    useSceneStore.getState().clear();
    const id = addTextLayer();
    const node = () => useSceneStore.getState().nodes.find((n) => n.id === id)!;
    const raster = () => getAssetCache().get(node().assetId)!;
    expect(node()).toMatchObject({ kind: 'text', text: TEXT_DEFAULT });
    expect(dots(raster())).toEqual(dots(renderTextRaster(TEXT_DEFAULT)));

    useSceneStore.getState().setText(id, { text: 'Dots!' });
    expect(dots(raster())).toEqual(dots(renderTextRaster(cfg({ text: 'Dots!' }))));

    useSceneStore.temporal.getState().undo();
    expect(node().text?.text).toBe(TEXT_DEFAULT.text);
    expect(dots(raster())).toEqual(dots(renderTextRaster(TEXT_DEFAULT)));

    // Duplicate: the clone draws into its own slot, so editing it leaves the original.
    useSceneStore.getState().setSelection([id]);
    duplicateSelection();
    const clone = useSceneStore.getState().nodes.find((n) => n.kind === 'text' && n.id !== id)!;
    expect(clone.assetId).not.toBe(node().assetId);
    useSceneStore.getState().setText(clone.id, { text: 'Copy' });
    expect(dots(getAssetCache().get(clone.assetId)!)).toEqual(
      dots(renderTextRaster(cfg({ text: 'Copy' }))),
    );
    expect(dots(raster())).toEqual(dots(renderTextRaster(TEXT_DEFAULT)));

    // A reopened project's text:N ids push the counter past them.
    syncTextAssets([{ ...node(), assetId: 'text:500' }]);
    expect(newTextAssetId()).toBe('text:501');
  });
});

describe('typing is one undo step', () => {
  it('a typing session (a gesture) undoes in one go', () => {
    useSceneStore.getState().clear();
    const id = addTextLayer();
    const text = () => useSceneStore.getState().nodes.find((n) => n.id === id)?.text?.text;
    beginGesture();
    for (const v of ['H', 'Hi', 'Hi!']) useSceneStore.getState().setText(id, { text: v });
    endGesture();
    expect(text()).toBe('Hi!');
    useSceneStore.temporal.getState().undo();
    expect(text()).toBe(TEXT_DEFAULT.text);
  });
});
