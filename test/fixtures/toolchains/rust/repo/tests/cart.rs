use shop::{Item, total_text};

#[test]
fn total_of_one_item() {
    assert_eq!(total_text(&[Item { price: 2, qty: None }]), "2");
}
