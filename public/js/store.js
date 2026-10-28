// ===== Store Frontend JavaScript =====

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

// Add to cart
function addToCart(productId, quantity = 1) {
  const formData = new FormData();
  formData.append('productId', productId);
  formData.append('quantity', quantity);

  fetch('/cart/add', {
    method: 'POST',
    body: formData
  })
  .then(r => {
    if (r.headers.get('content-type')?.includes('json')) return r.json();
    return r.text().then(() => ({ success: true }));
  })
  .then(data => {
    if (data.success !== false) {
      updateCartCount();
      showToast('Added to cart!', 'success');
    }
  })
  .catch(() => {
    // fallback: redirect to cart
    window.location.href = '/cart';
  });
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

// Init on page load
document.addEventListener('DOMContentLoaded', () => {
  updateCartCount();
});
