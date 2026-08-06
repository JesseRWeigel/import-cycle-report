import type { Invoice } from './invoice';

export interface Order {
  id: string;
  invoice: Invoice | null;
}
