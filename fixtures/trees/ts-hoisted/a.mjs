import { bName } from './b.mjs';

export function aName() {
  return 'a';
}

// Reading bName here is fine only because b exports a hoisted function declaration.
export const combined = bName();
