// Readable layer names for the one canvas: "Photo 1", "Drawing 2", … —
// numbered per kind, bottom-up, so a name stays put while layers above it change.
import type { SceneNode } from '../state/scene-store';
import { isVideoAsset } from './video-assets';

export type LayerKind =
  | 'photo'
  | 'drawing'
  | 'video'
  | 'element'
  | 'visualizer'
  | 'text'
  | 'recording';

export function layerKind(n: SceneNode): LayerKind {
  if (n.kind === 'image') return 'photo';
  if (n.kind === 'paint') return 'drawing';
  if (n.kind === 'recording') return 'recording';
  if (n.kind === 'visualizer') return 'visualizer';
  if (n.kind === 'text') return 'text';
  if (isVideoAsset(n.assetId)) return 'video';
  return 'element';
}

const KIND_LABEL: Record<LayerKind, string> = {
  photo: 'Photo',
  drawing: 'Drawing',
  video: 'Video',
  element: 'Element',
  visualizer: 'Visualizer',
  text: 'Text',
  recording: 'Recording',
};

/** id → display name for every layer. */
export function layerNames(nodes: SceneNode[]): Map<string, string> {
  const count = new Map<LayerKind, number>();
  const names = new Map<string, string>();
  for (const n of [...nodes].sort((a, b) => a.z - b.z)) {
    const k = layerKind(n);
    const c = (count.get(k) ?? 0) + 1;
    count.set(k, c);
    names.set(n.id, `${KIND_LABEL[k]} ${c}`);
  }
  return names;
}
