package cart

type Item struct {
	Price int
	Qty   int
}

// Total is the sum of the items' prices times their quantities (1 when not set).
func Total(items []Item) int {
	sum := 0
	for _, i := range items {
		qty := i.Qty
		if qty == 0 {
			qty = 1
		}
		sum += i.Price * qty
	}
	return sum
}
