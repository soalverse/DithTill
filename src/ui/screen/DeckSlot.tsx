import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DeckSlotTarget } from './deck-slot-context';

/**
 * Screen-shell seam (prototype). A deck marks the panels that
 * belong on the RIGHT edge rail by wrapping them in `<DeckSlot>`. Under the radio
 * shell there is no target, so they render inline exactly as before; under the
 * screen shell they portal into the right rail — same React tree, same state.
 */
export function DeckSlot({ children }: { children: ReactNode }) {
  const target = useContext(DeckSlotTarget);
  return target ? createPortal(children, target) : <>{children}</>;
}
