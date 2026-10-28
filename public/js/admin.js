// ===== Admin JavaScript =====

function renderSidebar(activePage) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const storeName = document.documentElement.getAttribute('data-store-name') || 'Store';

  const menuItems = [
    { section: '主要', items: [
      { key: 'dashboard', icon: '&#128202;', label: '仪表盘', href: '/admin/dashboard' },
    ]},
    { section: '商品管理', items: [
      { key: 'products', icon: '&#128230;', label: '产品列表', href: '/admin/products' },
      { key: 'categories', icon: '&#128193;', label: '商品分类', href: '/admin/categories' },
    ]},
    { section: '销售管理', items: [
      { key: 'orders', icon: '&#128722;', label: '订单管理', href: '/admin/orders' },
      { key: 'shipments', icon: '&#128666;', label: '物流管理', href: '/admin/shipments' },
    ]},
    { section: '财务管理', items: [
      { key: 'payment-accounts', icon: '&#128179;', label: '收款账户', href: '/admin/payment-accounts' },
      { key: 'withdrawal-accounts', icon: '&#127974;', label: '提款账户', href: '/admin/withdrawal-accounts' },
    ]},
    { section: '系统设置', items: [
      { key: 'settings', icon: '&#9881;', label: '店铺设置', href: '/admin/settings' },
      { key: 'change-password', icon: '&#128274;', label: '修改密码', href: '/admin/change-password' },
    ]},
  ];

  let html = `
    <div class="sidebar-header">
      <div class="logo">${storeName}<br><span style="font-size:12px;font-weight:400;">管理后台</span></div>
    </div>
    <nav class="sidebar-nav">
  `;

  menuItems.forEach(section => {
    html += `<div class="nav-section-title">${section.section}</div>`;
    section.items.forEach(item => {
      html += `
        <a href="${item.href}" class="nav-item ${item.key === activePage ? 'active' : ''}">
          <span class="icon">${item.icon}</span>
          <span>${item.label}</span>
        </a>
      `;
    });
  });

  html += `
    </nav>
    <div style="padding:20px;">
      <a href="/" target="_blank" class="nav-item" style="background:rgba(255,255,255,0.05); border-radius:8px;">
        <span class="icon">&#128279;</span>
        <span>访问店铺</span>
      </a>
    </div>
  `;

  sidebar.innerHTML = html;
}

// Image upload helper
function uploadImages(input, previewContainerId, hiddenInputId) {
  const files = input.files;
  if (!files || files.length === 0) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  fetch('/api/upload', {
    method: 'POST',
    body: formData
  })
  .then(r => r.json())
  .then(data => {
    if (data.success) {
      const container = document.getElementById(previewContainerId);
      const hiddenInput = document.getElementById(hiddenInputId);
      let currentImages = [];
      try { currentImages = JSON.parse(hiddenInput.value || '[]'); } catch {}
      
      data.files.forEach(f => {
        currentImages.push(f.url);
        const div = document.createElement('div');
        div.className = 'image-preview';
        div.innerHTML = `
          <img src="${f.url}" alt="${f.name}">
          <button type="button" class="remove-img" onclick="removeImage(this, '${f.url}', '${hiddenInputId}')">x</button>
        `;
        container.appendChild(div);
      });
      
      hiddenInput.value = JSON.stringify(currentImages);
    }
  })
  .catch(err => {
    alert('上传失败：' + err.message);
  });
}

function removeImage(btn, url, hiddenInputId) {
  const hiddenInput = document.getElementById(hiddenInputId);
  let images = [];
  try { images = JSON.parse(hiddenInput.value || '[]'); } catch {}
  images = images.filter(u => u !== url);
  hiddenInput.value = JSON.stringify(images);
  btn.parentElement.remove();
}

function confirmDelete(formId) {
  if (confirm('确定要删除此项吗？此操作不可撤销。')) {
    document.getElementById(formId).submit();
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
});
