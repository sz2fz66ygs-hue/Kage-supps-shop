const basket = JSON.parse(localStorage.getItem("kage_basket") || "{}");
let products = [];
let currentCat = "All";

function saveBasket() { localStorage.setItem("kage_basket", JSON.stringify(basket)); }

async function loadProducts() {
  const res = await fetch("/api/products");
  products = await res.json();
  renderCats();
  render();
}

function renderCats() {
  const cats = ["All", ...new Set(products.map(p => p.category).filter(Boolean))];
  document.getElementById("cats").innerHTML = cats.map(c =>
    `<button class="${c===currentCat?"active":""}" data-cat="${c}">${c}</button>`
  ).join("");
}

function render() {
  const q = document.getElementById("search").value.toLowerCase();
  const list = products.filter(p =>
    (currentCat === "All" || p.category === currentCat) &&
    p.name.toLowerCase().includes(q)
  );
  document.getElementById("products").innerHTML = list.map(p => {
    const qty = basket[p.id] || 0;
    const stock = Number(p.stock || 0);
    const badge = stock <= 5 ? `<span class="stock low">Low stock · ${stock} left</span>` : `<span class="stock ok">In stock</span>`;
    return `<article class="card">
      <div class="price">£${(p.pricePence/100).toFixed(2)}</div>
      <h3>${p.name}</h3>
      <div class="meta">${p.strength || ""} ${p.size || ""}</div>
      ${badge}
      <div class="qty">
        <button data-id="${p.id}" data-d="-1">−</button>
        <span>${qty}</span>
        <button data-id="${p.id}" data-d="1">+</button>
      </div>
    </article>`;
  }).join("") || "<p>No products</p>";
  renderBasket();
}

function renderBasket() {
  const items = Object.entries(basket).filter(([,q]) => q > 0);
  let total = 0;
  document.getElementById("basketLines").innerHTML = items.map(([id,q]) => {
    const p = products.find(x => x.id == id);
    if (!p) return "";
    total += p.pricePence * q;
    return `<div>${q} × ${p.name} — £${(p.pricePence*q/100).toFixed(2)}</div>`;
  }).join("") || "Empty";
  document.getElementById("basketTotal").textContent = "£" + (total/100).toFixed(2);
  document.getElementById("cartCount").textContent = items.reduce((s,[,q]) => s+q, 0);
  saveBasket();
}

document.getElementById("cats").addEventListener("click", e => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  currentCat = btn.dataset.cat;
  renderCats();
  render();
});
document.getElementById("search").addEventListener("input", render);
document.getElementById("products").addEventListener("click", e => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const id = btn.dataset.id;
  const d = Number(btn.dataset.d);
  basket[id] = Math.max(0, (basket[id] || 0) + d);
  if (basket[id] === 0) delete basket[id];
  render();
});

document.getElementById("checkout").addEventListener("click", async () => {
  const items = Object.entries(basket).filter(([,q]) => q>0).map(([id,quantity]) => ({ id:Number(id), quantity }));
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerName: document.getElementById("name").value,
      phone: document.getElementById("phone").value,
      address: document.getElementById("address").value,
      items
    })
  });
  const data = await res.json();
  document.getElementById("status").textContent = data.error || `Order #${data.orderId} — send ${data.payment?.quote?.USDT} USDT to ${data.payment?.address}`;
});

// Gate
document.getElementById("gateStart").addEventListener("click", async () => {
  const res = await fetch("/api/account/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: document.getElementById("gateName").value, phone: document.getElementById("gatePhone").value })
  });
  const data = await res.json();
  document.getElementById("gateStatus").textContent = data.code ? `Code: ${data.code}` : (data.error || data.message);
});
document.getElementById("gateVerify").addEventListener("click", async () => {
  const res = await fetch("/api/account/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: document.getElementById("gatePhone").value, code: document.getElementById("gateCode").value })
  });
  const data = await res.json();
  if (res.ok) {
    localStorage.setItem("kage_account_token", data.token);
    document.getElementById("gate").hidden = true;
    document.getElementById("shop").hidden = false;
    loadProducts();
  } else {
    document.getElementById("gateStatus").textContent = data.error || "Failed";
  }
});
document.getElementById("adminLogin").addEventListener("click", async () => {
  const res = await fetch("/api/admin/passkey-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passkey: document.getElementById("adminKey").value })
  });
  const data = await res.json();
  if (res.ok) {
    localStorage.setItem("kage_admin_token", data.token);
    document.getElementById("gate").hidden = true;
    document.getElementById("shop").hidden = false;
    loadProducts();
  } else {
    document.getElementById("adminStatus").textContent = data.error || "Invalid";
  }
});

if (localStorage.getItem("kage_account_token") || localStorage.getItem("kage_admin_token")) {
  document.getElementById("gate").hidden = true;
  document.getElementById("shop").hidden = false;
  loadProducts();
}
