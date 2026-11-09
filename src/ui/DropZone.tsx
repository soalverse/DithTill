import { useState, type ReactNode } from 'react';
import { isSongFile, loadMedia, loadSong } from './load-image';
import type { BurnSource } from './image-to-grid';

/** Drag-and-drop media loader (any image format, or a video — Group B). The
 *  Layers + menu is the click-to-pick path (LayersDoor AddLayerMenu). Hands the
 *  decoded source (HTMLImageElement or HTMLVideoElement) up. */
export function DropZone({
  onSource,
  songs = false,
  children,
}: {
  onSource: (src: BurnSource) => void;
  /** Accept a dropped music file as the canvas's song. */
  songs?: boolean;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file && songs && isSongFile(file)) void loadSong(file);
        else if (file && (file.type.startsWith('image/') || file.type.startsWith('video/')))
          loadMedia(file, onSource);
      }}
      style={{ outline: over ? '2px dashed #8a82d8' : '2px dashed transparent', borderRadius: 8 }}
    >
      {children}
    </div>
  );
}
