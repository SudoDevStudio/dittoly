use shop::{Item, total};

#[test]
fn total_counts_the_quantity() {
    assert_eq!(total(&[Item { price: 2, qty: Some(3) }]), 6);
}
