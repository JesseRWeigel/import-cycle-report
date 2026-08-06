import { PANEL_ID } from './panel';

export function drawBars(target: string, data: number[]) {
  return `${target || PANEL_ID}:${data.length}`;
}
