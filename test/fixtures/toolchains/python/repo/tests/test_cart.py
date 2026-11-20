from shop.cart import total


def test_total_of_one_item():
    assert total([{"price": 2}]) == 2
