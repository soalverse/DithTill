// =============================================================================
// Halftone MCP server (personal AI tooling — NOT part of the app bundle).
// A stdio Model Context Protocol server exposing the AI hand's tools:
//   render_halftone        — image file -> 1-bit halftone PNG (AI-1)
//   render_halftone_frames — ordered image set -> numbered frame PNGs (AI-2)
//   export_frames_video    — frames dir -> MP4/GIF through the app's own codec
//                            (the wasm build) (AI-2)
//   save_to_library        — AI-authored image -> a real Library element file
//                            in the app's library-inbox (AI-3)
//   create_scene / place_element / set_motion / export_loop — the headless
//                            Record: a scene JSON walked through the app's own
//                            pure loop renderer to MP4/GIF (AI-3)
// all through the app's own seams. Started via halftone-server-launcher.mjs
// (which registers tsx so the repo's extensionless TS imports resolve under
// plain node). stdout carries JSON-RPC — log to stderr.
// =============================================================================
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PALETTE_IDS, type PaletteId } from '../../src/core/dither-constants';
import { renderHalftone } from './halftone-pipeline';
import {
  exportFramesVideo,
  FPS_DEFAULT,
  FPS_MAX,
  FPS_MIN,
  FRAMES_MAX,
  renderHalftoneFrames,
} from './animation';
import { defaultInboxDir, LOOK_CELL_STYLES, saveElementFile } from './element-pipeline';
import {
  createSceneDoc,
  exportLoopFromScene,
  loadSceneDoc,
  MOTION_CYCLES_MAX,
  MOTION_CYCLES_MIN,
  MOTION_TYPES,
  placeElement,
  saveSceneDoc,
  setNodeMotion,
} from './scene-doc';

const PALETTES = PALETTE_IDS as [PaletteId, ...PaletteId[]];

/** MatrixId is a mixed string/number union — spelled out for the zod schema. */
const MATRIX = z
  .union([
    z.literal('none'),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal('dot'),
    z.literal('lines'),
    z.literal('cross'),
    z.literal('blue'),
  ])
  .describe("Dither screen: 'none', 2, 4, 8 (Bayer, default 8), 'dot', 'lines', 'cross', 'blue'");
/** A scene's Pattern: the screens above, or an error-diffusion recipe. */
const PATTERN = z
  .union([
    MATRIX,
    z.literal('floyd'),
    z.literal('atkinson'),
    z.literal('jarvis'),
    z.literal('stucki'),
    z.literal('sierra'),
  ])
  .describe(
    "Dither pattern: 'none', 2, 4, 8 (Bayer, default 8), 'dot', 'lines', 'cross', 'blue', or error diffusion 'floyd', 'atkinson', 'jarvis', 'stucki', 'sierra'",
  );

const CELL_STYLE = z
  .enum(LOOK_CELL_STYLES)
  .describe("Cell render style: 'square' = classic dither (default); 'round'/'block' = halftone");

/** The shared halftone dials — one schema for the single render AND the frame
 *  set (AI-2 locked shared dials: every frame of a loop uses the same look). */
const DIALS = {
  palette: z
    .enum(PALETTES)
    .optional()
    .describe("Colour ramp; 'two' = 1-bit Mono (default). Others are tinted ramps."),
  contrast: z.number().min(0.5).max(2.5).optional().describe('Contrast, 0.5–2.5 (default 1)'),
  invert: z.boolean().optional().describe('Invert tones before dotting (default false)'),
  gamma: z.number().min(0.4).max(2.5).optional().describe('Pre-dither gamma (default 1)'),
  black: z.number().int().min(0).max(120).optional().describe('Levels black point (default 0)'),
  white: z.number().int().min(135).max(255).optional().describe('Levels white point (default 255)'),
  cellSize: z
    .number()
    .int()
    .min(2)
    .max(14)
    .optional()
    .describe(
      'The "Pixel" dial, 2–14 (default 5). Smaller = finer grid = larger output PNG; ' +
        'output is always gridCells x 10 px.',
    ),
  shape: z
    .enum(['round', 'block'])
    .optional()
    .describe("Dot shape: 'round' circles (default) or 'block' squares"),
  dotSize: z
    .number()
    .int()
    .min(1)
    .max(32)
    .optional()
    .describe('Dot diameter in output px, 1–32 (default 10)'),
  tonal: z
    .boolean()
    .optional()
    .describe('Dots grow in brighter areas (default true); false = uniform dot size'),
  density: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Dot lattice density 1 (sparse) – 20 (cluster), default 10'),
  angle: z
    .number()
    .min(0)
    .max(90)
    .optional()
    .describe("The dot screen's angle in degrees, like a print ink (default 45)"),
  aspect: z
    .enum(['auto', 'square', 'landscape', 'portrait'])
    .optional()
    .describe(
      "Frame: 'auto' follows the source aspect (default); the app's fixed frames are " +
        'square 1:1, landscape 4:3, portrait 3:4 (source is contained, letterbox transparent)',
    ),
  background: z
    .string()
    .optional()
    .describe("Flat background '#rrggbb'; omitted = transparent PNG"),
  ink: z
    .string()
    .optional()
    .describe("Dot colour '#rrggbb'; omitted = the palette's brightest shade"),
};

/** Wrap a tool handler: any throw becomes a plain isError text result. */
function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text }] };
}
function toolError(
  tool: string,
  err: unknown,
): { content: { type: 'text'; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `${tool} failed: ${message}` }], isError: true };
}

export function createHalftoneServer(): McpServer {
  const server = new McpServer({ name: 'dithtill-halftone', version: '1.2.0' });

  server.registerTool(
    'render_halftone',
    {
      description:
        'Render an image file as 1-bit halftone dot art using the DithTill engine ' +
        '(the exact pipeline the desktop app uses). Writes an indexed PNG to `output`. ' +
        'Dots are placed on a blue-noise lattice; brighter areas light more dots, and ' +
        'with `tonal` on the dots also grow with brightness.',
      inputSchema: {
        input: z.string().describe('Absolute path to the source image (png/jpg/webp/svg…)'),
        output: z.string().describe('Absolute path for the rendered PNG (must end in .png)'),
        ...DIALS,
        preview: z
          .boolean()
          .optional()
          .describe('Also return the rendered PNG inline as image content (default false)'),
      },
    },
    async ({ input, output, preview, ...options }) => {
      try {
        if (!output.toLowerCase().endsWith('.png')) {
          throw new Error(`output must end in .png, got '${output}'`);
        }
        const result = await renderHalftone({ input, ...options });
        await mkdir(path.dirname(output), { recursive: true });
        await writeFile(output, result.png);
        const summary =
          `Rendered ${input} -> ${output}: ${result.width}x${result.height}px ` +
          `(${result.LW}x${result.LH} cells from a ${result.targetW}x${result.targetH} frame), ` +
          `${result.png.length.toLocaleString()} bytes.`;
        const content: (
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        )[] = [{ type: 'text', text: summary }];
        if (preview) {
          // MCP hosts truncate oversized tool results; keep inline previews sane.
          const PREVIEW_MAX_BYTES = 1_500_000;
          if (result.png.length <= PREVIEW_MAX_BYTES) {
            content.push({
              type: 'image',
              data: Buffer.from(result.png).toString('base64'),
              mimeType: 'image/png',
            });
          } else {
            content[0] = {
              type: 'text',
              text: `${summary} Preview omitted (over ${PREVIEW_MAX_BYTES.toLocaleString()} bytes); open the file instead.`,
            };
          }
        }
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `render_halftone failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'render_halftone_frames',
    {
      description:
        'Render an ORDERED set of source images as numbered halftone frame PNGs ' +
        '(frame_000001.png…) with ONE shared dial set — the animation half of the ' +
        'DithTill engine. The blue-noise lattice is fixed, so regions that do not ' +
        'change between sources render byte-identically in every frame (author only ' +
        'the motion). All sources must share one aspect. Export the result with ' +
        'export_frames_video.',
      inputSchema: {
        inputs: z
          .array(z.string())
          .min(1)
          .max(FRAMES_MAX)
          .describe(
            `Ordered absolute source paths — inputs[k] becomes frame k+1 (max ${FRAMES_MAX})`,
          ),
        outputDir: z
          .string()
          .describe('Absolute directory for the numbered frame PNGs (created if missing)'),
        ...DIALS,
      },
    },
    async ({ inputs, outputDir, ...dials }) => {
      try {
        const res = await renderHalftoneFrames({ inputs, outputDir, ...dials });
        return {
          content: [
            {
              type: 'text',
              text:
                `Rendered ${res.frames} frames -> ${res.pattern}: ${res.width}x${res.height}px each ` +
                `(${res.LW}x${res.LH} cells from a ${res.targetW}x${res.targetH} frame), ` +
                `${res.totalBytes.toLocaleString()} bytes total. ` +
                `Encode with export_frames_video (framesDir: ${outputDir}).`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `render_halftone_frames failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'export_frames_video',
    {
      description:
        'Encode a directory of numbered frames (frame_000001.png…, as written by ' +
        "render_halftone_frames) into a video with the app's own codec — the same encoder " +
        'and recipes as the app. The output extension picks the container: .mp4 (H.264, ' +
        'silent) or .gif (exact palette colours, loops forever). Frames must be palette art ' +
        '(256 colours or fewer). For a seamless loop make the frame AFTER the last equal ' +
        'frame 1, then leave it out.',
      inputSchema: {
        framesDir: z.string().describe('Absolute directory holding frame_000001.png…'),
        output: z.string().describe('Absolute output path; the extension picks .mp4 / .gif'),
        fps: z
          .number()
          .int()
          .min(FPS_MIN)
          .max(FPS_MAX)
          .optional()
          .describe(`Playback rate, ${FPS_MIN}–${FPS_MAX} (default ${FPS_DEFAULT})`),
      },
    },
    async ({ framesDir, output, fps }) => {
      try {
        const res = await exportFramesVideo({ framesDir, output, fps });
        return {
          content: [
            {
              type: 'text',
              text:
                `Encoded ${res.frames} frames @ ${res.fps} fps -> ${output} ` +
                `(${res.container}, ${res.seconds.toFixed(2)}s, ${res.bytes.toLocaleString()} bytes).`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `export_frames_video failed: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'save_to_library',
    {
      description:
        "Turn an AI-authored image (SVG/PNG/…) into a REAL DithTill Library element via the app's " +
        'own Burn intake: contained into the aspect frame, captured at element doc resolution, ' +
        'contrast/invert baked into per-cell tones, content-addressed. Writes a hash-verified ' +
        "element file into the app's library-inbox (default) — the app ingests it on next Library " +
        'open — and the file also feeds place_element directly. The v4 look dials (cellStyle/dots/' +
        'ink/background) travel WITH the element, not baked.',
      inputSchema: {
        input: z.string().describe('Absolute path to the source image (svg/png/jpg/webp…)'),
        aspect: z
          .enum(['square', 'landscape', 'portrait'])
          .optional()
          .describe("The app's fixed frames; default 'square'"),
        palette: z.enum(PALETTES).optional().describe("Colour ramp; 'two' = 1-bit Mono (default)"),
        matrix: MATRIX.optional(),
        contrast: z
          .number()
          .min(0.5)
          .max(2.5)
          .optional()
          .describe('Baked into the element tones (default 1)'),
        invert: z.boolean().optional().describe('Invert tones (baked; default false)'),
        gamma: z.number().min(0.4).max(2.5).optional().describe('Pre-dither gamma (default 1)'),
        black: z.number().int().min(0).max(120).optional().describe('Levels black point'),
        white: z.number().int().min(135).max(255).optional().describe('Levels white point'),
        cellStyle: CELL_STYLE.optional(),
        dotDensity: z.number().int().min(1).max(20).optional().describe('Halftone lattice density'),
        dotSize: z.number().int().min(1).max(32).optional().describe('Halftone dot diameter px'),
        dotGrow: z.boolean().optional().describe('Dots grow with brightness (default true)'),
        dotInk: z.string().optional().describe("Dot ink '#rrggbb' (travels in the look)"),
        background: z.string().optional().describe("Background '#rrggbb' (travels in the look)"),
        outputDir: z
          .string()
          .optional()
          .describe(
            "Where the element file lands; DEFAULT = the app's library-inbox " +
              '(%APPDATA%/com.soalverse.dithtill/library-inbox), so it appears in the app',
          ),
      },
    },
    async (args) => {
      try {
        const res = await saveElementFile(args);
        return textResult(
          `Saved element ${res.id.slice(0, 16)}… (${res.w}x${res.h} cells, ${res.aspect}` +
            `${res.neutralLook ? '' : ', styled look'}) -> ${res.file} ` +
            `(${res.bytes.toLocaleString()} bytes). The app ingests it on next Library open; ` +
            `place it in a scene with place_element.`,
        );
      } catch (err) {
        return toolError('save_to_library', err);
      }
    },
  );

  server.registerTool(
    'create_scene',
    {
      description:
        'Start a headless Record scene (a versioned scene JSON the other scene tools mutate). ' +
        'The scene is EXPLICIT: elements never restyle it — set cellStyle/dotDensity/background/' +
        "dotInk here (e.g. cellStyle 'round' + dotDensity to render halftone elements as dots). " +
        'The loop length is integer frames at fps; motions close seamlessly at the loop edge.',
      inputSchema: {
        output: z.string().describe('Absolute path for the scene file (.json)'),
        aspect: z.enum(['square', 'landscape', 'portrait']).optional().describe("Default 'square'"),
        frames: z
          .number()
          .int()
          .min(1)
          .max(FRAMES_MAX)
          .optional()
          .describe(`Loop length in frames, 1–${FRAMES_MAX} (default 36)`),
        fps: z
          .number()
          .int()
          .min(FPS_MIN)
          .max(FPS_MAX)
          .optional()
          .describe(`Playback rate (default ${FPS_DEFAULT}; 36 frames @ 12 = a 3 s loop)`),
        seed: z.number().int().optional().describe('Deterministic master seed (default fixed)'),
        palette: z.enum(PALETTES).optional().describe('Scene-default ramp (elements override)'),
        matrix: PATTERN.optional(),
        background: z.string().optional().describe("Canvas '#rrggbb'; omitted = transparent"),
        dotInk: z.string().optional().describe("Halftone ink '#rrggbb'; omitted = brightest shade"),
        cellStyle: CELL_STYLE.optional(),
        dotDensity: z.number().int().min(1).max(20).optional().describe('Halftone lattice density'),
      },
    },
    async ({ output, ...opts }) => {
      try {
        if (!output.toLowerCase().endsWith('.json')) {
          throw new Error(`scene file must end in .json, got '${output}'`);
        }
        const doc = createSceneDoc(opts);
        await mkdir(path.dirname(output), { recursive: true });
        await saveSceneDoc(output, doc);
        const dims = `${doc.aspect}, ${doc.frames} frames @ ${doc.fps} fps, ${doc.cellStyle}`;
        return textResult(`Created scene ${output} (${dims}). Add elements with place_element.`);
      } catch (err) {
        return toolError('create_scene', err);
      }
    },
  );

  server.registerTool(
    'place_element',
    {
      description:
        'Place a saved element file into a scene as a node (the app model: centre + scale + ' +
        'rotation in scene cells; z stacks in placement order). scale 1 = the element at its ' +
        'native capture cells (~2/3 of a square scene edge); 1.5 fills a square scene. Returns ' +
        'the nodeId for set_motion.',
      inputSchema: {
        scene: z.string().describe('Path to the scene file (create_scene wrote it)'),
        elementFile: z.string().describe('Path to the element file (save_to_library wrote it)'),
        nx: z.number().min(0).max(1).optional().describe('Centre X as a fraction (default 0.5)'),
        ny: z.number().min(0).max(1).optional().describe('Centre Y as a fraction (default 0.5)'),
        scale: z.number().min(0.05).max(20).optional().describe('Uniform scale (default 1)'),
        rotationDeg: z.number().optional().describe('Rotation about the centre (default 0)'),
        opacity: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe('Percent, blended pre-dither (default 100)'),
      },
    },
    async ({ scene, ...opts }) => {
      try {
        const doc = await loadSceneDoc(scene);
        const placed = await placeElement(doc, opts);
        await saveSceneDoc(scene, doc);
        const p = placed.placement;
        return textResult(
          `Placed ${placed.elementId.slice(0, 12)}… as node '${placed.nodeId}' at ` +
            `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) cells, scale ${p.scaleX}, ` +
            `${p.rotationDeg}° (element ${placed.w}x${placed.h} cells). ` +
            `Scene now has ${doc.nodes.length} node(s).`,
        );
      } catch (err) {
        return toolError('place_element', err);
      }
    },
  );

  server.registerTool(
    'set_motion',
    {
      description:
        "Give a placed node one of the app's coded motions (H-A0). Integer cycles = the speed " +
        'AND the seamless-wrap guarantee (any whole number closes at the loop edge). Types: ' +
        'drift/bob/bounce/shake = translation (amp in scene cells), parallax = orbit, ' +
        'spin = revolutions, pendulum = swing (amp in degrees), pulse = breathe (amp in % ' +
        "scale), blink/twinkle = intensity, marquee = wrap-around scroll. 'none' clears.",
      inputSchema: {
        scene: z.string().describe('Path to the scene file'),
        nodeId: z.string().describe("The node to animate (place_element returned it, e.g. 'n1')"),
        type: z.enum([...MOTION_TYPES, 'none']).describe("Motion type, or 'none' to clear"),
        cycles: z
          .number()
          .int()
          .min(MOTION_CYCLES_MIN)
          .max(MOTION_CYCLES_MAX)
          .optional()
          .describe('Cycles per loop = speed, 1–8 (default 1); integer → seamless'),
        amp: z.number().min(0).optional().describe('Amplitude in per-type units (sane default)'),
        directionDeg: z
          .number()
          .optional()
          .describe('Direction for drift/marquee/bounce: 0 = right, 90 = down'),
        phase0: z.number().min(0).max(1).optional().describe('Phase offset in turns (default 0)'),
      },
    },
    async ({ scene, ...opts }) => {
      try {
        const doc = await loadSceneDoc(scene);
        const motion = setNodeMotion(doc, opts);
        await saveSceneDoc(scene, doc);
        return textResult(
          motion
            ? `Node '${opts.nodeId}' now ${motion.type} (${motion.cycles} cycle(s)/loop, ` +
                `amp ${motion.amp}).`
            : `Node '${opts.nodeId}' motion cleared.`,
        );
      } catch (err) {
        return toolError('set_motion', err);
      }
    },
  );

  server.registerTool(
    'export_loop',
    {
      description:
        "Render a scene's integer loop frames through the app's own pure renderer " +
        '(evaluateScene → resolveSceneGrid → the export raster — preview == export) straight ' +
        "into the app's own codec. The output extension picks .mp4 / .gif. " +
        'Deterministic: the same scene + elements always produce the same video.',
      inputSchema: {
        scene: z.string().describe('Path to the scene file'),
        output: z.string().describe('Absolute output path; extension picks the container'),
        fps: z
          .number()
          .int()
          .min(FPS_MIN)
          .max(FPS_MAX)
          .optional()
          .describe("Override the scene's fps for this export only"),
      },
    },
    async ({ scene, output, fps }) => {
      try {
        const res = await exportLoopFromScene({ sceneFile: scene, output, fps });
        return textResult(
          `Exported ${res.nodes}-node scene (${res.width}x${res.height} cells) -> ${output}: ` +
            `${res.frames} frames @ ${res.fps} fps (${res.container}, ${res.seconds.toFixed(2)}s, ` +
            `${res.bytes.toLocaleString()} bytes).`,
        );
      } catch (err) {
        return toolError('export_loop', err);
      }
    },
  );

  // The default inbox is worth asserting at startup so a misconfigured HOME
  // fails loudly in the log rather than silently writing nowhere.
  if (!existsSync(path.dirname(defaultInboxDir()))) {
    console.error(`dithtill-halftone: note — app data dir not found at ${defaultInboxDir()}`);
  }

  return server;
}

/** Connect the server over stdio. Called by halftone-server-launcher.mjs. */
export async function startHalftoneServer(): Promise<void> {
  const server = createHalftoneServer();
  await server.connect(new StdioServerTransport());
  console.error('dithtill-halftone MCP server running on stdio');
}
