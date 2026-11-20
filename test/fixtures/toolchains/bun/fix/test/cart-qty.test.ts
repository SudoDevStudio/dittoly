import { expect, test } from 'bun:test';
import { total } from '../src/cart.ts';

test('total counts the quantity', () => {
  expect(total([{ price: 2, qty: 3 }])).toBe(6);
});
