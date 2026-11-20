using Shop;
using Xunit;

public class CartQtyTests
{
    [Fact]
    public void TotalCountsTheQuantity() => Assert.Equal(6, Cart.Total([new Item(2, 3)]));
}
