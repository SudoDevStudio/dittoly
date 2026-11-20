package com.acme.shop

import kotlin.test.Test
import kotlin.test.assertEquals

class CartTest {
    @Test
    fun totalOfOneItem() {
        assertEquals(2, total(listOf(Item(2))))
    }
}
