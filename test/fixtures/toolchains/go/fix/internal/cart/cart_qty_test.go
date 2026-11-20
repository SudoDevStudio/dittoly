package cart

import "testing"

func TestTotalCountsTheQuantity(t *testing.T) {
	if got := Total([]Item{{Price: 2, Qty: 3}}); got != 6 {
		t.Fatalf("got %d, want 6", got)
	}
}
