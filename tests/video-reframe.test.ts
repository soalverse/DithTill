// Video-look carry-over: a saved Burn REFRAME rides the
// video element (schema v3, additive) and becomes the dropped node's CROP. The
// contracts: neutral reframes change NOTHING (ids dedupe against pre-v3 saves),
// non-neutral reframes are save-variants (own id, shared source blob), and the
// frame→source→raster-cell math lands on the exact window Burn showed.
import { describe, it, expect } from 'vitest';
import { buildVideoElement, isNeutralReframe, type BuildVideoInput } from '../src/core/library';
import { videoRasterDims } from '../src/core/video-frames';
import { reframeCropCells } from '../src/ui/image-to-grid';

const baseInput = (over: Partial<BuildVideoInput> = {}): BuildVideoInput => ({
  bytes: new Uint8Array([1, 2, 3, 4]),
  mime: 'video/mp4',
  w: 1920,
  h: 1080,
  inSeconds: 0,
  outSeconds: 2,
  fps: 30,
  thumbnail: '',
  source: 'burn',
  aspect: 'landscape',
  palette: 'two',
  matrix: 8,
  createdAt: 0,
  ...over,
});

describe('video reframe carry-over', () => {
  it('neutral reframe = pre-v3 identity (same id, no reframe field)', async () => {
    const plain = await buildVideoElement(baseInput());
    const neutral = await buildVideoElement(
      baseInput({ reframe: { zoom: 1, offsetX: 0, offsetY: 0 } }),
    );
    expect(neutral.record.id).toBe(plain.record.id);
    expect(neutral.record.reframe).toBeUndefined();
    expect(isNeutralReframe(undefined)).toBe(true);
    expect(isNeutralReframe({ zoom: 1, offsetX: 0, offsetY: 0 })).toBe(true);
    expect(isNeutralReframe({ zoom: 1.2, offsetX: 0, offsetY: 0 })).toBe(false);
  });

  it('a non-neutral reframe is its OWN element sharing the one source blob', async () => {
    const plain = await buildVideoElement(baseInput());
    const zoomed = await buildVideoElement(
      baseInput({ reframe: { zoom: 2, offsetX: 0, offsetY: 0 } }),
    );
    const panned = await buildVideoElement(
      baseInput({ reframe: { zoom: 2, offsetX: 0.25, offsetY: 0 } }),
    );
    expect(zoomed.record.id).not.toBe(plain.record.id);
    expect(panned.record.id).not.toBe(zoomed.record.id);
    expect(zoomed.record.reframe).toEqual({ zoom: 2, offsetX: 0, offsetY: 0 });
    // Every variant references the SAME source bytes (dedupe / GC safety).
    expect(zoomed.blobs[0].hash).toBe(plain.blobs[0].hash);
    expect(panned.blobs[0].hash).toBe(plain.blobs[0].hash);
  });

  it('centered 2x zoom on a 16:9 source in the landscape frame → the centre 4:3 window', () => {
    const raster = videoRasterDims(1920, 1080); // {192, 108}
    const crop = reframeCropCells(
      1920,
      1080,
      'landscape',
      { zoom: 2, offsetX: 0, offsetY: 0 },
      raster.w,
      raster.h,
    );
    // Burn's landscape frame is 480x360; base contain-scale 0.25, x2 zoom → the
    // visible source rect is [480,1440]x[180,900] → cells /10.
    expect(crop).toEqual({ x: 48, y: 18, w: 96, h: 72 });
  });

  it('a pan past the edge clamps to the source bounds', () => {
    const raster = videoRasterDims(1000, 1000); // {192, 192}
    const crop = reframeCropCells(
      1000,
      1000,
      'square',
      { zoom: 1, offsetX: 0.5, offsetY: 0 },
      raster.w,
      raster.h,
    );
    // Shifted half a frame right: only the left half of the source stays visible.
    expect(crop).toEqual({ x: 0, y: 0, w: 96, h: 192 });
  });

  it('neutral or fully-visible reframes return null (drop stays uncropped)', () => {
    expect(reframeCropCells(1920, 1080, 'landscape', undefined, 192, 108)).toBeNull();
    expect(
      reframeCropCells(1920, 1080, 'landscape', { zoom: 1, offsetX: 0, offsetY: 0 }, 192, 108),
    ).toBeNull();
    // An offset so tiny it rounds back to the full raster → null, not a 1-cell sliver.
    expect(
      reframeCropCells(1000, 1000, 'square', { zoom: 1, offsetX: 0.001, offsetY: 0 }, 192, 192),
    ).toBeNull();
  });

  it('an extreme zoom still yields a valid >=1-cell crop', () => {
    const crop = reframeCropCells(
      1000,
      1000,
      'square',
      { zoom: 480, offsetX: 0, offsetY: 0 },
      192,
      192,
    );
    expect(crop).not.toBeNull();
    expect(crop!.w).toBeGreaterThanOrEqual(1);
    expect(crop!.h).toBeGreaterThanOrEqual(1);
    expect(crop!.x + crop!.w).toBeLessThanOrEqual(192);
    expect(crop!.y + crop!.h).toBeLessThanOrEqual(192);
  });
});
