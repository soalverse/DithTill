import type { BurnSource } from './image-to-grid';
import { importTrack } from './audio-engine';
import { useLoopStore } from '../state/loop-store';
import { notifyBanner } from '../state/notify-store';

/** A music file? (MIME first; some systems hand audio over with no type, so the
 *  extension decides then.) */
export function isSongFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  return !file.type && /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|aiff?)$/i.test(file.name);
}

/** A picked/dropped music file → the canvas's song, and Sound switches on so it's heard
 *  and the visualizers move to it (Load takes songs too). */
export async function loadSong(file: File): Promise<boolean> {
  const ok = await importTrack(file.name, new Uint8Array(await file.arrayBuffer()));
  const lp = useLoopStore.getState();
  if (ok && !lp.meta.withAudio) lp.setWithAudio(true);
  notifyBanner(ok ? `Track: ${file.name}` : 'No audio in that file');
  return ok;
}

/** The file each loaded picture came from — a project stores the ORIGINAL bytes, not a
 *  re-encode. */
const imageFiles = new WeakMap<object, File>();
export const imageFileOf = (src: object): File | undefined => imageFiles.get(src);

/** Decode an image File into an HTMLImageElement and hand it up. Shared by the
 *  drop zone and the Load button so both accept any browser-decodable image
 *  (PNG incl. transparent, JPEG, WebP, GIF, …). */
export function loadImageFile(file: File, onImage: (img: HTMLImageElement) => void): void {
  const url = URL.createObjectURL(file);
  const img = new Image();
  imageFiles.set(img, file);
  img.onload = () => {
    onImage(img);
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

/** Load a video File into a muted, looping HTMLVideoElement and hand it up once
 *  the first frame is decodable (Group B video burn). The element IS the burn
 *  source — its current frame dithers through the same `sourceToGrid` path as a
 *  still. The object URL lives for the element's lifetime (revoking it would
 *  break playback), so it's released when a fresh source replaces this one. */
export function loadVideoFile(file: File, onVideo: (video: HTMLVideoElement) => void): void {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.dataset.mime = file.type; // object URLs lose the container type; keep it for Library saves
  video.muted = true; // required for autoplay; the deck Sound toggle unmutes on the first user gesture (B1)
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.onloadeddata = () => {
    onVideo(video);
    // Autoplay may be blocked; the first decoded frame still shows + dithers.
    void video.play().catch(() => {});
  };
  video.src = url;
}

/** Dispatch a dropped/picked File to the right loader by MIME (video vs image). */
export function loadMedia(file: File, onSource: (src: BurnSource) => void): void {
  if (file.type.startsWith('video/')) loadVideoFile(file, onSource);
  else loadImageFile(file, onSource);
}
