const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

let products = [];
let categories = [];
let selectedCategory = null;
const basket = {};

const icons = {
  "Supplements": "⚡️",
  "Accessories": "🧴",
  "Trial products": "🧪"
};

const money = pence => `£${(pence / 100).toFixed(2)}`;

async function init() {
  const res = await fetch("/api/products");
  products = await res.json();

  categories = [...new Set(products.map(p => p.category))];
  selectedCategory = categories[0] || null;

  render();
}

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
}

function renderTabs() {
  document.querySelector("#tabs").innerHTML = categories.map(category => `
    <button
      class="tab ${category === selectedCategory ? "active" : ""}"
      data-category="${escapeHtml(category)}"
    >
      ${icons[category] || ""} ${escapeHtml(category)}
    </button>
  `).join("");

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedCategory = btn.dataset.category;
      render();
    });
  });
}

function renderProducts() {
  const visible = products.filter(p => p.category === selectedCategory);

  document.querySelector("#products").innerHTML = visible.map(product => {
    const qty = basket[product.id] || 0;

    return `
      <div class="card">
        <div>
          <div class="name">
            ${escapeHtml(product.name)}
            <span class="subtitle">${escapeHtml(product.subtitle || "")}</span>
          </div>

          <span class="stock ${product.stock <= 10 ? "low" : ""}">
            ${product.stock <= 10 ? `${product.stock} left` : `${product.stock} in stock`}
          </span>
        </div>

        <div class="right">
          <div class="price">${money(product.pricePence)}</div>

          <div class="qty">
            <button data-action="minus" data-id="${product.id}">−</button>
            <span class="count">${qty}</span>
            <button data-action="plus" data-id="${product.id}">+</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-action]").forEach(button => {
    button.addEventListener("click", () => {
      const id = Number(button.dataset.id);
      const product = products.find(p => p.id === id);
      const current = basket[id] || 0;
      const delta = button.dataset.action === "plus" ? 1 : -1;
      const next = Math.max(0, Math.min(product.stock, current + delta));

      if (next === 0) delete basket[id];
      else basket[id] = next;

      tg?.HapticFeedback?.selectionChanged();
      render();
    });
  });
}

function renderBasket() {
  const entries = Object.entries(basket);

  if (!entries.length) {
    document.querySelector("#basketLines").textContent = "Your basket is empty.";
    document.querySelector("#basketTotal").textContent = "Total: £0.00";
    return;
  }

  let total = 0;

  document.querySelector("#basketLines").innerHTML = entries.map(([id, qty]) => {
    const product = products.find(p => p.id === Number(id));
    const subtotal = product.pricePence * qty;
    total += subtotal;

    return `<div>${escapeHtml(product.name)} × ${qty} = <b>${money(subtotal)}</b></div>`;
  }).join("");

  document.querySelector("#basketTotal").textContent = `Total: ${money(total)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
