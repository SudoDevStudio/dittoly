from shop.cart import total


def test_total_counts_the_quantity():
    assert total([{"price": 2, "qty": 3}]) == 6
