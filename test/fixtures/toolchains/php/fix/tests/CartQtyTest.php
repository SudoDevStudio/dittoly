<?php

use Acme\Shop\Cart;
use PHPUnit\Framework\TestCase;

final class CartQtyTest extends TestCase
{
    public function testTotalCountsTheQuantity(): void
    {
        $this->assertSame(6, Cart::total([['price' => 2, 'qty' => 3]]));
    }
}
