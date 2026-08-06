import { formatLabel } from './index';

export class Widget {
  constructor(readonly label: string) {}

  render(): string {
    return formatLabel(this.label);
  }
}
