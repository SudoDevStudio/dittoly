<?php

namespace Acme\Shop;

final class Cart
{
    /** @param list<array{price: int, qty?: int}> $items */
    public static function total(array $items): int
    {
        return array_sum(array_map(fn (array $i): int => $i['price'], $items));
    }
}
