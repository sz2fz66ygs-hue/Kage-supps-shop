const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// Lawful demo products only.
const products = [
  { id: 1, name: "Example Product", subtitle: "Demo listing", pricePence: 1250, stock: 12 },
  { id: 2, name: "Example Accessory", subtitle: "Demo listing", pricePence: 800, stock: 7 }
];

const basket = {};
const money = p => `£${(p / 100).toFixed(2)}`;

function renderProducts() {
  document.getElementById("products").innerHTML = products.map(p => {
    const q = basket[p.id] || 0;
    return `
      <div class="product">
        <div>
          <h3>${p.name}</h3>
          <div class="sub">${p.subtitle}</div>
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
  }).join("");

  document.querySelectorAll("[data-d]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const delta = Number(btn.dataset.d);
      const p = products.find(x => x.id === id);
      const next = Math.max(0, Math.min(p.stock, (basket[id] || 0) + delta));
      if (next === 0) delete basket[id];
      else basket[id] = next;
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
    return { productId: p.id, name: p.name, quantity, unitPricePence: p.pricePence };
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
  renderProducts();
  renderBasket();
}
render();
