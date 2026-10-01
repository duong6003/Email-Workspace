import { createContext, useContext } from 'react';
import type { SetFocusHeaderState } from './save-state.js';

/** Provided by AppShell, consumed by whatever screen mounts on a focus route (today, only BuilderScreen). */
export const FocusHeaderContext = createContext<SetFocusHeaderState>(() => {});

export function useSetFocusHeader(): SetFocusHeaderState {
  return useContext(FocusHeaderContext);
}
