require "minitest/autorun"
require "cart"

class CartTest < Minitest::Test
  def test_total_of_one_item
    assert_equal 2, Cart.total([{ price: 2 }])
  end
end
