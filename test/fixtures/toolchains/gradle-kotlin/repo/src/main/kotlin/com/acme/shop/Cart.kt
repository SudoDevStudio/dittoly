package com.acme.shop

data class Item(val price: Int, val qty: Int? = null)

fun total(items: List<Item>): Int = items.sumOf { it.price }
