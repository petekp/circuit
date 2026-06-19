// Checkout total. Today every order pays a flat $5 shipping fee. A new
// free-shipping path (free over $50) must be added BEHIND a feature flag so
// existing behavior is unchanged when the flag is off or absent.
export function checkoutTotal(subtotal, flags = {}) {
  return subtotal + 5;
}
