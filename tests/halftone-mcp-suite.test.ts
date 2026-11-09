// =============================================================================
// AI-3 full-suite tools (scripts/mcp/element-pipeline + scene-doc) — the
// headless draw → Library → Record → export chain. Proves: save_to_library
// mints the app's exact element shape (content-addressed, doc resolution,
// verified file), the scene tools mirror the app's node model (placement /
// look mapping / motion defaults + clamps), the loop render is deterministic
// and motions actually move, and the whole chain round-trips over stdio
// through the real MCP server, encode included (the codec wasm is committed).
// =============================================================================
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseElementFile } from '../src/core/element-file';
import { sceneDims } from '../src/state/scene-store';
import { renderLoopFramePng } from '../src/core/loop-render';
import { elementDocDims, saveElementFile } from '../scripts/mcp/element-pipeline';
import {
  createSceneDoc,
  exportLoopFromScene,
  loadSceneDoc,
  placeElement,
  saveSceneDoc,
  sceneToRenderInput,
  setNodeMotion,
} from '../scripts/mcp/scene-doc';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const LAUNCHER = path.join(ROOT, 'scripts', 'mcp', 'halftone-server-launcher.mjs');

let dir: string;
let heartSvg: string;

/** A chunky white heart on transparent — the end-goal demo's "draw" half. */
const HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <path d="M120 208 C 60 160 24 124 24 84 C 24 52 48 32 76 32 C 94 32 110 42 120 58
           C 130 42 146 32 164 32 C 192 32 216 52 216 84 C 216 124 180 160 120 208 Z"
        fill="#f0f0f0"/>
</svg>`;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dithtill-mcp-suite-'));
  heartSvg = path.join(dir, 'heart.svg');
  await writeFile(heartSvg, HEART_SVG);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('save_to_library (headless element mint)', () => {
  it('captures at the app doc resolution per aspect', () => {
    expect(elementDocDims('square')).toEqual({ w: 128, h: 128 });
    expect(elementDocDims('landscape')).toEqual({ w: 128, h: 96 });
    expect(elementDocDims('portrait')).toEqual({ w: 96, h: 128 });
  });

  it('writes a hash-verified element file with a content-addressed id', async () => {
    const res = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'elements') });
    expect(existsSync(res.file)).toBe(true);
    expect({ w: res.w, h: res.h }).toEqual({ w: 128, h: 128 });
    expect(res.neutralLook).toBe(true);
    const { record } = await parseElementFile(await readFile(res.file, 'utf8'));
    expect(record.id).toBe(res.id);
    expect(record.id).toBe(record.pngHash); // neutral look → id == pngHash
    expect(record.source).toBe('burn');
  });

  it('is content-addressed: the same source + dials re-mint the SAME id', async () => {
    const a = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'el-a') });
    const b = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'el-b') });
    expect(a.id).toBe(b.id);
  });

  it('a styled look folds into the id and travels in the record', async () => {
    const styled = await saveElementFile({
      input: heartSvg,
      cellStyle: 'round',
      dotDensity: 14,
      dotInk: '#ff4040',
      outputDir: path.join(dir, 'el-styled'),
    });
    expect(styled.neutralLook).toBe(false);
    const { record } = await parseElementFile(await readFile(styled.file, 'utf8'));
    expect(record.look?.cellStyle).toBe('round');
    expect(record.look?.dotInk).toEqual([255, 64, 64]);
    expect(record.id).not.toBe(record.pngHash);
  });

  it('refuses a fully transparent source', async () => {
    const empty = path.join(dir, 'empty.svg');
    await writeFile(empty, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await expect(
      saveElementFile({ input: empty, outputDir: path.join(dir, 'el-x') }),
    ).rejects.toThrow(/fully transparent/);
  });
});

describe('scene doc (headless Record)', () => {
  it('creates a validated doc and round-trips through disk', async () => {
    const doc = createSceneDoc({ aspect: 'landscape', frames: 24, fps: 8, cellStyle: 'round' });
    expect(doc.scene.palette).toBe('two');
    const file = path.join(dir, 'scene-rt.json');
    await saveSceneDoc(file, doc);
    expect(await loadSceneDoc(file)).toEqual(doc);
  });

  it('refuses bad caps and foreign files', async () => {
    expect(() => createSceneDoc({ frames: 0 })).toThrow(/frames must be/);
    expect(() => createSceneDoc({ frames: 901 })).toThrow(/frames must be/);
    expect(() => createSceneDoc({ fps: 61 })).toThrow(/fps must be/);
    const foreign = path.join(dir, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ format: 'other' }));
    await expect(loadSceneDoc(foreign)).rejects.toThrow(/not a dithtill-scene/);
  });

  it("place_element mirrors the app's node mapping (placement in cells, record look)", async () => {
    const el = await saveElementFile({
      input: heartSvg,
      cellStyle: 'round',
      dotSize: 8,
      outputDir: path.join(dir, 'el-place'),
    });
    const doc = createSceneDoc({});
    const placed = await placeElement(doc, { elementFile: el.file, nx: 0.25, ny: 0.75, scale: 2 });
    const dims = sceneDims('square');
    expect(placed.nodeId).toBe('n1');
    expect(placed.placement).toEqual({
      x: dims.w * 0.25,
      y: dims.h * 0.75,
      scaleX: 2,
      scaleY: 2,
      rotationDeg: 0,
    });
    const node = doc.nodes[0];
    expect(node.look.palette).toBe('two');
    expect(node.look.matrix).toBe(8);
    expect(node.look.dotSize).toBe(8); // the v4 look rides the node, like the app
    const second = await placeElement(doc, { elementFile: el.file });
    expect(second.nodeId).toBe('n2');
    expect(doc.nodes[1].z).toBe(2);
  });

  it('set_motion applies the app defaults, clamps, and clears', async () => {
    const el = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'el-m') });
    const doc = createSceneDoc({});
    await placeElement(doc, { elementFile: el.file });

    const pulse = setNodeMotion(doc, { nodeId: 'n1', type: 'pulse' });
    expect(pulse).toMatchObject({ type: 'pulse', cycles: 1, amp: 15, phase0: 0 });

    const bounce = setNodeMotion(doc, { nodeId: 'n1', type: 'bounce', cycles: 99 });
    expect(bounce).toMatchObject({ cycles: 8, ax: 0, ay: 1 }); // clamp + per-type direction

    expect(setNodeMotion(doc, { nodeId: 'n1', type: 'none' })).toBeNull();
    expect(doc.nodes[0].motion).toBeNull();

    expect(() => setNodeMotion(doc, { nodeId: 'nope', type: 'spin' })).toThrow(/nodes: n1/);
  });

  it('export input is deterministic and a pulse motion actually moves the frames', async () => {
    const el = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'el-render') });
    const doc = createSceneDoc({ frames: 12, background: '#0a0a0c' });
    await placeElement(doc, { elementFile: el.file, scale: 1.2 });
    setNodeMotion(doc, { nodeId: 'n1', type: 'pulse', amp: 20 });

    const input = await sceneToRenderInput(doc);
    expect(input.assets.size).toBe(1);
    const f0a = renderLoopFramePng(input, 0);
    const f0b = renderLoopFramePng(await sceneToRenderInput(doc), 0);
    expect(Buffer.from(f0a).equals(Buffer.from(f0b))).toBe(true); // deterministic
    // Frame 3 of 12 = the pulse's quarter-cycle PEAK (frame 6 is the sine's
    // zero-crossing — identical to frame 0 by construction, not a bug).
    const peak = renderLoopFramePng(input, 3);
    expect(Buffer.from(f0a).equals(Buffer.from(peak))).toBe(false); // it breathes

    const empty = createSceneDoc({});
    await expect(sceneToRenderInput(empty)).rejects.toThrow(/scene is empty/);
  });
});

describe('export_loop (the codec e2e)', () => {
  it('renders + encodes a seamless GIF from a motion scene', async () => {
    const el = await saveElementFile({ input: heartSvg, outputDir: path.join(dir, 'el-e2e') });
    const sceneFile = path.join(dir, 'scene-e2e.json');
    const doc = createSceneDoc({ frames: 6, fps: 6, background: '#101014' });
    await placeElement(doc, { elementFile: el.file });
    setNodeMotion(doc, { nodeId: 'n1', type: 'spin' });
    await saveSceneDoc(sceneFile, doc);

    const out = path.join(dir, 'loop.gif');
    const res = await exportLoopFromScene({ sceneFile, output: out });
    expect(res).toMatchObject({ container: 'gif', frames: 6, fps: 6, nodes: 1 });
    expect((await readFile(out)).subarray(0, 6).toString('ascii')).toBe('GIF89a');

    const mp4 = path.join(dir, 'loop.mp4');
    const mres = await exportLoopFromScene({ sceneFile, output: mp4 });
    expect(mres).toMatchObject({ container: 'mp4', frames: 6, fps: 6 });
    expect((await readFile(mp4)).subarray(4, 8).toString('ascii')).toBe('ftyp');
    await expect(
      exportLoopFromScene({ sceneFile, output: path.join(dir, 'x.webm') }),
    ).rejects.toThrow(/must end in \.mp4 or \.gif/);
  }, 60_000);
});

describe('AI-3 suite over stdio (MCP server e2e)', () => {
  it('serves the full chain: save → scene → place → motion → export', async () => {
    const client = new Client({ name: 'suite-e2e', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [LAUNCHER] });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const t of [
        'save_to_library',
        'create_scene',
        'place_element',
        'set_motion',
        'export_loop',
      ]) {
        expect(tools).toContain(t);
      }

      const elDir = path.join(dir, 'stdio-el');
      const saved = await client.callTool({
        name: 'save_to_library',
        arguments: { input: heartSvg, outputDir: elDir },
      });
      expect(saved.isError ?? false).toBe(false);
      const savedText = (saved.content as { type: string; text?: string }[]).find(
        (c) => c.type === 'text',
      )?.text as string;
      const elementFile = /-> (.+?\.json)/.exec(savedText)?.[1] as string;
      expect(elementFile && existsSync(elementFile)).toBe(true);

      const sceneFile = path.join(dir, 'stdio-scene.json');
      for (const [name, args] of [
        ['create_scene', { output: sceneFile, frames: 6, fps: 6 }],
        ['place_element', { scene: sceneFile, elementFile }],
        ['set_motion', { scene: sceneFile, nodeId: 'n1', type: 'pulse' }],
      ] as const) {
        const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
        expect(r.isError ?? false, `${name} should succeed`).toBe(false);
      }

      // A bad motion surfaces as a tool error, not a protocol crash.
      const bad = await client.callTool({
        name: 'set_motion',
        arguments: { scene: sceneFile, nodeId: 'n9', type: 'spin' },
      });
      expect(bad.isError).toBe(true);

      const out = path.join(dir, 'stdio-loop.gif');
      const exported = await client.callTool({
        name: 'export_loop',
        arguments: { scene: sceneFile, output: out },
      });
      expect(exported.isError ?? false).toBe(false);
      expect(existsSync(out)).toBe(true);
    } finally {
      await client.close();
    }
  }, 90_000);
});
