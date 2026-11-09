import { createContext } from 'react';

/** The right-rail element the screen shell portals `<DeckSlot>` panels into
 *  (null under the radio shell = render inline). See DeckSlot.tsx. */
export const DeckSlotTarget = createContext<HTMLElement | null>(null);
