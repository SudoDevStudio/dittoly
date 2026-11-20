package com.acme.shop;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class CartQtyTest {
  @Test
  void totalCountsTheQuantity() {
    assertEquals(6, Cart.total(List.of(new Cart.Item(2, 3))));
  }
}
