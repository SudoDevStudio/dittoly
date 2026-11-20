package com.acme.shop;

import java.util.List;

public final class Cart {
  public record Item(int price, Integer qty) {}

  private Cart() {}

  public static int total(List<Item> items) {
    int sum = 0;
    for (Item i : items) sum += i.price() * (i.qty() == null ? 1 : i.qty());
    return sum;
  }
}
