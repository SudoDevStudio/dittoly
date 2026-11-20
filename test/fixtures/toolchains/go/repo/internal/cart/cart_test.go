package cart

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestTotalOfOneItem(t *testing.T) {
	if d := cmp.Diff(2, Total([]Item{{Price: 2}})); d != "" {
		t.Fatal(d)
	}
}
