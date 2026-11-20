import { expect, test } from 'bun:test';
import ms from 'ms';
import { total } from '../src/cart.ts';

test('total of one item', () => {
  expect(total([{ price: 2 }])).toBe(2);
  expect(ms('2s')).toBe(2000);
});
