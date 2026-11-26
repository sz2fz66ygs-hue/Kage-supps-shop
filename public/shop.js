if (!localStorage.getItem("kage_account_token") && !localStorage.getItem("kage_admin_token")) {
  location.href = "/login";
}

const basket = JSON.parse(localStorage.getItem("kage_basket") || "{}");
let products = [];
const save = () => localStorage.setItem("kage_basket", JSON.stringify(basket));

async function load() {
  products = await (await fetch("/api/products")).json();
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
  document.getElementById("nav").innerHTML = cats.map(c =>
    `<a href="#cat-${slug(c)}">${c}</a>`
  ).join("");
  render();
}

function slug(s) { return String(s).toLowerCase().replace(/\s+/g, "-"); }

function render() {
  const q = (document.getElementById("search").value || "").toLowerCase();
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))];
  document.getElementById("sections").innerHTML = cats.map(cat => {
    const list = products.filter(p => p.category === cat && p.name.toLowerCase().includes(q));
    if (!list.length) return "";
    return `<section class="section" id="cat-${slug(cat)}">
      <h2>${cat}</h2>
      <div class="products">${list.map(card).join("")}</div>
    </section>`;
  }).join("");
  renderBasket();
}

function card(p) {
  const qty = basket[p.id] || 0;
  return `<article class="card">
    <div class="price">£${(p.pricePence / 100).toFixed(2)}</div>
    <h3>${p.name}</h3>
    <div class="meta">${p.strength || ""} ${p.size || ""}</div>
    <div class="qty">
      <button data-id="${p.id}" data-d="-1">−</button>
      <span>${qty}</span>
      <button data-id="${p.id}" data-d="1">+</button>
    </div>
  </article>`;
}

function renderBasket() {
  const items = Object.entries(basket).filter(([, q]) => q > 0);
  let total = 0;
  document.getElementById("basketLines").innerHTML = items.map(([id, q]) => {
    const p = products.find(x => x.id == id);
    if (!p) return "";
    total += p.pricePence * q;
    return `<div>${q} × ${p.name}</div>`;
  }).join("") || "<div>Empty</div>";
  document.getElementById("basketTotal").textContent = "£" + (total / 100).toFixed(2);
  document.getElementById("cartCount").textContent = items.reduce((s, [, q]) => s + q, 0);
  save();
}

document.getElementById("search").oninput = render;
document.getElementById("sections").onclick = e => {
  const b = e.target.closest("button[data-id]");
  if (!b) return;
  const id = b.dataset.id;
  const d = +b.dataset.d;
  basket[id] = Math.max(0, (basket[id] || 0) + d);
  if (!basket[id]) delete basket[id];
  render();
};
document.getElementById("place").onclick = async () => {
  const items = Object.entries(basket).filter(([, q]) => q > 0).map(([id, quantity]) => ({ id: +id, quantity }));
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
  document.getElementById("status").textContent = data.error || `Order #${data.orderId} · ${data.payment?.quote?.USDT || ""} USDT`;
};

load();
