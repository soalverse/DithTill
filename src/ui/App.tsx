import { useEffect, type ReactNode } from 'react';
import { DropZone } from './DropZone';
import { CanvasControls } from './CanvasControls';
import { importToCanvas, useImageLayerSync } from './image-layers';
import { ScreenShell } from './screen/ScreenShell';
import { useModeStore } from '../state/mode-store';
import { useLibraryStore } from '../state/library-store';
import { requestPersistentStorage } from '../platform/library-db';
import { LibraryScreen } from './modes/LibraryScreen';
import { LibraryDeck } from './modes/LibraryDeck';
import { SceneStage } from './SceneStage';
import { initProjects } from './projects';

export function App() {
  const mode = useModeStore((s) => s.mode);

  // Photo layers stay in step with their dials, the Pixel and the aspect.
  useImageLayerSync();

  // Load the persisted library and ask for durable on-device storage.
  useEffect(() => {
    void useLibraryStore.getState().init();
    void requestPersistentStorage();
    // Reopen the last project and keep the canvas auto-saved.
    void initProjects();
  }, []);

  let screen: ReactNode;
  let deck: ReactNode;
  if (mode === 'canvas') {
    // ONE canvas: a layered scene. Drop or Import adds a photo layer; the
    // brush adds drawing layers; Library elements arrive as layers.
    screen = (
      <DropZone onSource={importToCanvas} songs>
        <SceneStage />
      </DropZone>
    );
    deck = <CanvasControls />;
  } else {
    screen = <LibraryScreen />;
    deck = <LibraryDeck />;
  }

  return <ScreenShell screen={screen} deck={deck} />;
}
