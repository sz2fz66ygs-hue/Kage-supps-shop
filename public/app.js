const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const categories = [
  { name: "Oils", icon: "🛢️" },
  { name: "Orals", icon: "💪" },
  { name: "Pharma", icon: "💊" },
  { name: "Peps", icon: "⚡" }
];

const sectionOrder = {
  Oils: ["Testosterone", "DHT’s", "19-Nor’s", "Blends", "Pre-Workouts"],
  Orals: ["Main Orals", "Pre-Workout Orals", "Other"],
  Pharma: ["Cycle Support", "Hair & Skincare", "Nootropics", "Painkillers", "Sexual Health"],
  Peps: ["Recovery", "Performance", "Weight Management", "Other"]
};

// Add/edit demo or lawful non-regulated products here.
const products = [
  {
    id: 1,
    category: "Oils",
    section: "Testosterone",
    name: "Example Product",
    subtitle: "Demo listing",
    pricePence: 1250,
    stock: 12
  },
  {
    id: 2,
    category: "Pharma",
    section: "Hair & Skincare",
    name: "Example Accessory",
    subtitle: "Demo listing",
    pricePence: 800,
    stock: 7
  }
];

const basket = {};
let currentCategory = categories[0].name;

const money = p => `£${(p / 100).toFixed(2)}`;

function stockBadge(stock) {
  if (stock <= 0) return `<span class="stock out">Out of stock</span>`;
  if (stock <= 10) return `<span class="stock low">${stock} left</span>`;
  return `<span class="stock good">${stock} in stock</span>`;
}

function renderTabs() {
  document.getElementById("tabs").innerHTML = categories.map(c => `
    <button class="tab ${c.name === currentCategory ? "active" : ""}" data-category="${c.name}">
      ${c.icon} ${c.name}
    </button>
  `).join("");

  document.querySelectorAll("[data-category]").forEach(btn => {
    btn.addEventListener("click", () => {
      currentCategory = btn.dataset.category;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function productCard(p) {
  const q = basket[p.id] || 0;

  return `
    <div class="product">
      <div>
        <h3>${p.name}</h3>
        <div class="sub">${p.subtitle || ""}</div>
        ${stockBadge(p.stock)}
      </div>
      <div>
        <div class="price">${money(p.pricePence)}</div>
        <div class="qty">
          <button data-id="${p.id}" data-d="-1" ${q === 0 ? "disabled" : ""}>−</button>
          <span>${q}</span>
          <button data-id="${p.id}" data-d="1" ${q >= p.stock ? "disabled" : ""}>+</button>
        </div>
      </div>
    </div>
  `;
}

function renderProducts() {
  let html = "";

  (sectionOrder[currentCategory] || []).forEach(section => {
    const items = products.filter(
      p => p.category === currentCategory && p.section === section
    );

    html += `<div class="section-title">${section}</div>`;
    html += items.length
      ? items.map(productCard).join("")
      : `<div class="empty">No products added yet.</div>`;
  });

  document.getElementById("products").innerHTML = html;

  document.querySelectorAll("[data-d]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const delta = Number(btn.dataset.d);
      const p = products.find(x => x.id === id);
      if (!p) return;

      const next = Math.max(0, Math.min(p.stock, (basket[id] || 0) + delta));
      if (next === 0) delete basket[id];
      else basket[id] = next;

      tg?.HapticFeedback?.selectionChanged();
      render();
    });
  });
}

function basketTotal() {
  return Object.entries(basket).reduce((sum, [id, qty]) => {
    const p = products.find(x => x.id === Number(id));
    return sum + (p ? p.pricePence * qty : 0);
  }, 0);
}

function renderBasket() {
  const entries = Object.entries(basket);
  const lines = document.getElementById("basketLines");

  if (!entries.length) {
    lines.textContent = "Your basket is empty.";
  } else {
    lines.innerHTML = entries.map(([id, qty]) => {
      const p = products.find(x => x.id === Number(id));
      return `${p.name} × ${qty} = <b>${money(p.pricePence * qty)}</b>`;
    }).join("<br>");
  }

  document.getElementById("basketTotal").textContent = money(basketTotal());
  document.getElementById("cartCount").textContent =
    entries.reduce((n, [, qty]) => n + qty, 0);
}

document.getElementById("cartJump").addEventListener("click", () => {
  document.getElementById("checkout").scrollIntoView({ behavior: "smooth" });
});

document.getElementById("checkoutBtn").addEventListener("click", async () => {
  const status = document.getElementById("status");

  const items = Object.entries(basket).map(([id, quantity]) => {
    const p = products.find(x => x.id === Number(id));
    return {
      productId: p.id,
      name: p.name,
      quantity,
      unitPricePence: p.pricePence
    };
  });

  if (!items.length) {
    status.textContent = "Add an item to your basket first.";
    return;
  }

  const customerName = document.getElementById("name").value.trim();
  const telegramUsername = document.getElementById("handle").value.trim();
  const address = document.getElementById("address").value.trim();

  if (!customerName || !address) {
    status.textContent = "Enter your name and delivery address.";
    return;
  }

  status.textContent = "Creating order...";

  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName,
      telegramUsername,
      address,
      items,
      totalPence: basketTotal()
    })
  });

  const data = await res.json();

  if (!res.ok) {
    status.textContent = data.error || "Could not create order.";
    return;
  }

  status.innerHTML = `
    Order #${data.orderId} created.<br>
    Status: awaiting payment.<br><br>
    ${data.payment.instructions}
  `;
});

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
}

render();
