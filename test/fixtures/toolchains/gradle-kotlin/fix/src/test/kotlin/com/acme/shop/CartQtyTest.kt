package com.acme.shop

import kotlin.test.Test
import kotlin.test.assertEquals

class CartQtyTest {
    @Test
    fun totalCountsTheQuantity() {
        assertEquals(6, total(listOf(Item(2, 3))))
    }
}
