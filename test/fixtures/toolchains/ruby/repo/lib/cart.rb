module Cart
  def self.total(items)
    items.sum { |item| item[:price] }
  end
end
