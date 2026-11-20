namespace Shop;

public record Item(int Price, int? Qty = null);

public static class Cart
{
    public static int Total(IEnumerable<Item> items) => items.Sum(i => i.Price * (i.Qty ?? 1));
}
