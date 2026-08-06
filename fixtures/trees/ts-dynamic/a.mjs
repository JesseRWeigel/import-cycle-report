export const aName = 'a';

export async function loadB() {
  return import('./b.mjs');
}

export async function loadAny(name) {
  return import(name);
}
