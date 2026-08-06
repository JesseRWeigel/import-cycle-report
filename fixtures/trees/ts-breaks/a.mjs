import { b } from './b.mjs';

export const a = 'a';

// This runs while b is still being evaluated the other way round, which is the whole problem.
export const combined = a + b;
