pub struct Item {
    pub price: u32,
    pub qty: Option<u32>,
}

/// The sum of the items' prices.
pub fn total(items: &[Item]) -> u32 {
    items.iter().map(|i| i.price).sum()
}

/// The total as text.
pub fn total_text(items: &[Item]) -> String {
    itoa::Buffer::new().format(total(items)).to_string()
}
