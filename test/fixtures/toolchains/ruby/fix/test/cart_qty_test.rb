require "minitest/autorun"
require "cart"

class CartQtyTest < Minitest::Test
  def test_total_counts_the_quantity
    assert_equal 6, Cart.total([{ price: 2, qty: 3 }])
  end
end
