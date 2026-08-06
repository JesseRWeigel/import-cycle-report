export const aName = 'a';

export async function both() {
  const b = await import('./b.mjs');
  return aName + b.bName;
}
