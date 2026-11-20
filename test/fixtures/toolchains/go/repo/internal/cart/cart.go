package cart

type Item struct {
	Price int
	Qty   int
}

// Total is the sum of the items' prices.
func Total(items []Item) int {
	sum := 0
	for _, i := range items {
		sum += i.Price
	}
	return sum
}
