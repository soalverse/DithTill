import { useLibraryStore } from '../../state/library-store';
import { DeckSlot } from '../screen/DeckSlot';
import { exportElements } from '../library-actions';
import { dropFromLibrary } from '../record-actions';

/**
 * The Library deck — a persistent action bar (Load to stage · Export ·
 * Delete · Clear), greyed until ≥1 element is selected. Export/Delete act on the
 * whole selection (batch); Load to stage takes a single element onto the Draw
 * base (the Library→Draw loop). Multi-element placement is the Record scene
 * (increment 3) — the selection model is already built for it.
 */
export function LibraryDeck() {
  const elements = useLibraryStore((s) => s.elements);
  const selected = useLibraryStore((s) => s.selected);
  const remove = useLibraryStore((s) => s.remove);
  const clearSelection = useLibraryStore((s) => s.clearSelection);

  const count = selected.length;
  const selectedRecs = elements.filter((e) => selected.includes(e.id));

  return (
    <div className="deck-cols">
      <div className="deck-panel deck-panel-grow lib-deck-info">
        <div className="lib-deck-status">
          {count ? `${count} selected` : 'Tap elements to select'}
        </div>
      </div>
      <div className="deck-vsep" />
      <DeckSlot>
        <div className="deck-panel deck-rail">
          <span className="deck-panel-label">Selection</span>
          <button
            type="button"
            className="deck-load"
            disabled={!count}
            title="Add the selected element(s) to the canvas as layers, exactly as saved"
            onClick={() => {
              if (count) void dropFromLibrary(selected);
            }}
          >
            Add to canvas
          </button>
          <div className="deck-hsep" />
          <button
            type="button"
            className="deck-load"
            disabled={!count}
            title="Export the selected element(s) as PNG"
            onClick={() => {
              if (count) void exportElements(selectedRecs);
            }}
          >
            Export
          </button>
          <button
            type="button"
            className="deck-load"
            disabled={!count}
            title="Delete the selected element(s) from your library"
            onClick={() => {
              if (count) void remove(selected);
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="deck-load"
            disabled={!count}
            title="Clear the selection"
            onClick={clearSelection}
          >
            Clear
          </button>
        </div>
      </DeckSlot>
    </div>
  );
}
