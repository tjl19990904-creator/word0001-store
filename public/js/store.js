// ===== Store Frontend JavaScript =====

// UI copy for the current locale is rendered by the server into window.I18N.
// Read it lazily: this file may load before the page-level script defines it.
// Pages that do not provide it fall back to English.
function tr(key, fallback) {
  const dictionary = (typeof window !== 'undefined' && window.I18N) || {};
  return dictionary[key] || fallback;
}

// Cart count update
function updateCartCount() {
  fetch('/api/cart/count')
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById('cart-count');
      if (el) {
        el.textContent = data.count;
        el.style.display = data.count > 0 ? 'flex' : 'none';
      }
    })
    .catch(() => {});
}

// Add to cart using URL-encoded fields supported by Express body parsing.
async function addToCart(productId, quantity = 1) {
  try {
    const response = await fetch('/cart/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({ productId: String(productId), quantity: String(quantity) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      throw new Error(result.error || tr('cart.addError', 'Unable to add this item to your cart. Please try again.'));
    }
    updateCartCount();
    showToast(tr('cart.added', 'Added to cart!'), 'success');
  } catch (error) {
    showToast(error.message || tr('cart.addError', 'Unable to add this item to your cart. Please try again.'), 'error');
  }
}

// Buy now skips the cart page: persist this item in the session, then open checkout.
async function buyNow(productId, quantity = 1) {
  try {
    const response = await fetch('/cart/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Accept': 'application/json'
      },
      body: new URLSearchParams({ productId: String(productId), quantity: String(quantity) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) {
      throw new Error(result.error || tr('cart.checkoutError', 'Unable to prepare checkout for this item.'));
    }
    window.location.assign('/checkout');
  } catch (error) {
    showToast(error.message || tr('cart.checkoutError', 'Unable to open checkout. Please try again.'), 'error');
  }
}

// Toast notification
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 30px;
    right: 30px;
    background: ${type === 'success' ? '#28a745' : type === 'error' ? '#dc3545' : '#17a2b8'};
    color: #fff;
    padding: 14px 24px;
    border-radius: 8px;
    font-size: 15px;
    font-weight: 500;
    box-shadow: 0 4px 15px rgba(0,0,0,0.15);
    z-index: 9999;
    animation: slideIn 0.3s ease;
  `;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// Quantity selector
function changeQty(delta, inputId) {
  const input = document.getElementById(inputId);
  if (input) {
    let val = parseInt(input.value) + delta;
    if (val < 1) val = 1;
    input.value = val;
  }
}

// Product image gallery
function changeMainImage(src, thumbEl) {
  const mainImg = document.getElementById('main-product-image');
  if (mainImg) mainImg.src = src;
  
  document.querySelectorAll('.thumb').forEach(t => t.classList.remove('active'));
  if (thumbEl) thumbEl.classList.add('active');
}

// Tab switching
function switchTab(tabId, btnEl) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  
  const content = document.getElementById('tab-' + tabId);
  if (content) content.classList.add('active');
  if (btnEl) btnEl.classList.add('active');
}

// Show "Sign in" or the customer's first name in the header.
// The session probe only returns the signed-in customer's own public profile.
async function updateAccountNav() {
  const actions = document.querySelector('.header-actions');
  if (!actions || document.getElementById('account-link')) return;

  let session = { loggedIn: false, customer: null };
  try {
    const response = await fetch('/api/account/session', { headers: { Accept: 'application/json' } });
    if (response.ok) session = await response.json();
  } catch (_) {
    // Network hiccup: keep the neutral "Sign in" link.
  }

  const link = document.createElement('a');
  link.id = 'account-link';
  link.className = 'account-link';
  link.href = session.loggedIn ? '/account' : '/account/login';
  link.textContent = session.loggedIn
    ? ((session.customer && session.customer.firstName) || tr('nav.myAccount', 'My account'))
    : tr('nav.signIn', 'Sign in');
  actions.insertBefore(link, actions.firstChild);
}

// Init on page load
document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
  updateAccountNav();
});
