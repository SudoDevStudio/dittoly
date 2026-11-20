using Shop;
using Xunit;

public class CartTests
{
    [Fact]
    public void TotalOfOneItem() => Assert.Equal(2, Cart.Total([new Item(2)]));
}
