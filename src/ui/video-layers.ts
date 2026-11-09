// =============================================================================
// VIDEO layers. Importing a video puts it on the canvas as a layer —
// the existing video element (live frames via video-assets, audio, the loop export)
// addressed by a SESSION record (session-assets), so nothing lands in the Library
// until the user Saves. Timing and trims live on the timeline (its clips, step 3).
// =============================================================================
import { useSceneStore } from '../state/scene-store';
import { useBurnStore } from '../state/burn-store';
import { buildVideoElement, type VideoAssetRecord } from '../core/library';
import { VIDEO_FPS } from '../core/video-frames';
import { notifyBanner, notifyConfirm } from '../state/notify-store';
import { dropFromLibrary } from './record-actions';
import { registerSessionAsset } from './session-assets';

const once = (el: HTMLVideoElement, ev: string) =>
  new Promise<void>((res) => el.addEventListener(ev, () => res(), { once: true }));

/** A small thumbnail of the current frame (the record shape requires one). */
function thumbOf(video: HTMLVideoElement): string {
  const c = document.createElement('canvas');
  const k = 64 / Math.max(1, video.videoWidth, video.videoHeight);
  c.width = Math.max(1, Math.round(video.videoWidth * k));
  c.height = Math.max(1, Math.round(video.videoHeight * k));
  c.getContext('2d')?.drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function mintRecord(
  base: { bytes: Uint8Array; mime: string; w: number; h: number; thumbnail: string },
  inSeconds: number,
  outSeconds: number,
): Promise<VideoAssetRecord> {
  const scene = useSceneStore.getState().scene;
  const built = await buildVideoElement({
    ...base,
    inSeconds,
    outSeconds,
    fps: VIDEO_FPS,
    source: 'burn',
    aspect: useBurnStore.getState().aspect,
    palette: scene.palette,
    matrix: scene.matrix,
    createdAt: Date.now(),
  });
  return built.record;
}

/** Import a video file as a new layer on top of the canvas (its whole length). */
export async function importVideoLayer(video: HTMLVideoElement): Promise<void> {
  try {
    if (video.readyState < 2) await once(video, 'loadeddata');
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      notifyBanner('That video has no length to play');
      return;
    }
    const bytes = new Uint8Array(await (await fetch(video.src)).arrayBuffer());
    const base = {
      bytes,
      mime: video.dataset.mime || 'video/mp4',
      w: video.videoWidth,
      h: video.videoHeight,
      thumbnail: thumbOf(video),
    };
    const rec = await mintRecord(base, 0, duration);
    registerSessionAsset(rec, { hash: rec.videoHash, data: bytes }, duration);
    useSceneStore.getState().setTool('arrange');
    await dropFromLibrary([rec.id]);
    notifyBanner('Video added — it plays once Animate arrives; Trim is in its settings');
  } catch (e) {
    console.error('Video import failed:', e);
    void notifyConfirm("Couldn't add that video", 'Import failed');
  }
}
