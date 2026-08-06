import { applyPatch } from './reducer';

export const EMPTY = { items: [] as string[] };

// Read at module evaluation time, which is what makes this cycle bite.
export const initial = applyPatch(EMPTY, { items: ['first'] });
