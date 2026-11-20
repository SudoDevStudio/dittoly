module Cart
  def self.total(items)
    items.sum { |item| item[:price] * (item[:qty] || 1) }
  end
end
