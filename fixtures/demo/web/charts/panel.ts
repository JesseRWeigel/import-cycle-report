export const PANEL_ID = 'panel';

export async function renderPanel(data: number[]) {
  const { drawBars } = await import('./bars');
  return drawBars(PANEL_ID, data);
}
