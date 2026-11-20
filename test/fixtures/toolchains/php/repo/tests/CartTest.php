<?php

use Acme\Shop\Cart;
use PHPUnit\Framework\TestCase;

final class CartTest extends TestCase
{
    public function testTotalOfOneItem(): void
    {
        $this->assertSame(2, Cart::total([['price' => 2]]));
    }
}
