import { assertEquals } from '@std/assert';
import { total } from '../src/cart.ts';

Deno.test('total counts the quantity', () => {
  assertEquals(total([{ price: 2, qty: 3 }]), 6);
});
