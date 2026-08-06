import { aName } from './a.mjs';

export const bName = () => 'b';
export const both = () => aName() + bName();
