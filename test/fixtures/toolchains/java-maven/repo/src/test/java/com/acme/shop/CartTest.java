package com.acme.shop;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.Test;

class CartTest {
  @Test
  void totalOfOneItem() {
    assertEquals(2, Cart.total(List.of(new Cart.Item(2, null))));
  }
}
