import { EMPTY } from './state';

// A const arrow is in the temporal dead zone until this line runs, so a partner module that
// calls it during its own evaluation gets a ReferenceError rather than a function.
export const applyPatch = (base: object, patch: object) => ({ ...EMPTY, ...base, ...patch });
