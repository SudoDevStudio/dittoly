export interface Item {
  price: number;
  qty?: number;
}

export const total = (items: Item[]): number => items.reduce((n, i) => n + i.price * (i.qty ?? 1), 0);
