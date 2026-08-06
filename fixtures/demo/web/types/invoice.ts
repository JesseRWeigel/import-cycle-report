import { Order } from './order';

export interface Invoice {
  id: string;
  order: Order;
}

export const emptyInvoice = (order: Order): Invoice => ({ id: '', order });
