import { assertEquals } from '@std/assert';
import { total } from '../src/cart.ts';

Deno.test('total of one item', () => {
  assertEquals(total([{ price: 2 }]), 2);
});
