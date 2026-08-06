import { bName } from './b.mjs';

export const aName = () => 'a';
export const both = () => aName() + bName();
