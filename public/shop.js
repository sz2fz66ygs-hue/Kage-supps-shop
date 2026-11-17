const tokenKey = "kage_site_token";
const gate = document.querySelector("#gate");
const shop = document.querySelector("#shop");
const gateError = document.querySelector("#gateError");
const productsEl = document.querySelector("#products");
const tabsEl = document.querySelector("#tabs");
const cartCount = document.querySelector("#cartCount");
const basketLines = document.querySelector("#basketLines");
const basketTotal = document.querySelector("#basketTotal");
const account = document.querySelector("#account");
const checkout = document.querySelector("#checkout");

let products = [];
let cart = [];
let activeCategory = "All";
let me = null;

const money = pence => `£${(Number(pence || 0) / 100).toFixed(2)}`;
const strengthOf = product => {
  const source = `${product.name || ""} ${product.subtitle || ""}`;
  const mgml = source.match(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*ml/i);
  if (mgml) return `${mgml[1]}mg/ml`;
  const mg = source.match(/(\d+(?:\.\d+)?)\s*mg/i);
  if (mg) return `${mg[1]}mg`;
  const pct = source.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return `${pct[1]}%`;
  return product.subtitle || "Standard";
};
const baseName = product => String(product.siteName || product.name || "")
  .replace(/\(?\d+(?:\.\d+)?\s*(mg\/ml|mg|%)\)?/ig, "")
  .replace(/\s+/g, " ")
  .trim();

function showError(message) {
  gateError.textContent = message || "";
}

async function requestCode() {
  showError("");
  const handle = document.querySelector("#handle").value.trim();
  const res = await fetch("/api/site/request-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle })
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error || "Could not send a code.");
  document.querySelector("#codeWrap").hidden = false;
  showError("Code sent in Telegram.");
}

async function verifyCode() {
  showError("");
  const handle = document.querySelector("#handle").value.trim();
  const code = document.querySelector("#code").value.trim();
  const res = await fetch("/api/site/verify-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, code })
  });
  const data = await res.json();
  if (!res.ok) return showError(data.error || "Code not accepted.");
  localStorage.setItem(tokenKey, data.token);
  await openShop();
}

async function openShop() {
  const token = localStorage.getItem(tokenKey);
  if (!token) return;
  const res = await fetch("/api/site/me", { headers: { "x-site-token": token } });
  if (!res.ok) {
    localStorage.removeItem(tokenKey);
    return;
  }
  me = await res.json();
  const productRes = await fetch("/api/products");
  products = await productRes.json();
  gate.hidden = true;
  shop.hidden = false;
  renderTabs();
  renderProducts();
  renderAccount();
}

function renderTabs() {
  const categories = ["All", ...new Set(products.map(product => product.category || "Other"))];
  tabsEl.innerHTML = categories.map(category => `<button class="tab ${category === activeCategory ? "active" : ""}" data-category="${category}">${category}</button>`).join("");
  tabsEl.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      activeCategory = button.dataset.category;
      account.hidden = true;
      checkout.hidden = false;
      renderTabs();
      renderProducts();
    });
  });
}

function groups() {
  const query = document.querySelector("#shopSearch").value.trim().toLowerCase();
  const visible = products.filter(product => {
    if (activeCategory !== "All" && product.category !== activeCategory) return false;
    if (!query) return true;
    return `${product.siteName || product.name} ${product.subtitle || ""}`.toLowerCase().includes(query);
  });
  const grouped = new Map();
  for (const product of visible) {
    const key = `${product.category}|${baseName(product)}`;
    const group = grouped.get(key) || { name: baseName(product), category: product.category, items: [] };
    group.items.push(product);
    grouped.set(key, group);
  }
  return [...grouped.values()];
}

function renderProducts() {
  productsEl.innerHTML = groups().map(group => {
    const first = group.items[0];
    const strengths = group.items.map(product => `<button type="button" data-id="${product.id}">${strengthOf(product)} · ${money(product.pricePence)}</button>`).join("");
    return `<article class="product-card">
      <img src="/logo.png" alt="">
      <div>
        <strong>${group.name}</strong>
        <div class="strengths">${strengths}</div>
        <div>${first.stock > 0 ? `${first.stock} in stock` : "Out of stock"}</div>
      </div>
    </article>`;
  }).join("") || "<p>Nothing matches.</p>";
  productsEl.querySelectorAll(".strengths button").forEach(button => {
    button.addEventListener("click", () => addToCart(Number(button.dataset.id)));
  });
}

function addToCart(id) {
  const product = products.find(item => Number(item.id) === id);
  if (!product || product.stock < 1) return;
  const line = cart.find(item => item.id === id);
  if (line) line.quantity += 1;
  else cart.push({ id, name: product.siteName || product.name, pricePence: product.pricePence, quantity: 1 });
  renderCart();
}

function renderCart() {
  cartCount.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.pricePence * item.quantity, 0);
  basketTotal.textContent = money(total);
  basketLines.innerHTML = cart.length
    ? cart.map(item => `<div>${item.quantity} × ${item.name} · ${money(item.pricePence * item.quantity)}</div>`).join("")
    : "Your basket is empty.";
}

function renderAccount() {
  document.querySelector("#accountHandle").textContent = `@${me.handle}`;
  document.querySelector("#accountCredit").textContent = `Store credit: ${money(me.storeCreditPence)}`;
  document.querySelector("#accountOrders").innerHTML = (me.orders || []).map(order => `<div class="account-order"><strong>#${order.orderId}</strong> · ${money(order.totalPence)}<br>${order.paymentStatus} · ${order.fulfilmentStatus || "not shipped"}${order.trackingNumber ? `<br>Tracking: ${order.trackingNumber}` : ""}</div>`).join("") || "<p>No orders yet.</p>";
}

async function placeOrder() {
  const token = localStorage.getItem(tokenKey);
  const res = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-token": token },
    body: JSON.stringify({
      customerName: document.querySelector("#name").value.trim(),
      telegramUsername: me.handle,
      telegramId: me.telegramId,
      phone: document.querySelector("#phone").value.trim(),
      address: document.querySelector("#address").value.trim(),
      items: cart.map(item => ({ id: item.id, quantity: item.quantity }))
    })
  });
  const data = await res.json();
  if (!res.ok) {
    document.querySelector("#checkoutError").textContent = data.error || "Could not place the order.";
    return;
  }
  cart = [];
  renderCart();
  document.querySelector("#checkoutError").textContent = `Order #${data.orderId || data.order?.orderId || ""} placed. Finish payment in Telegram.`;
}

document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
document.querySelector("#accountBtn").addEventListener("click", () => {
  account.hidden = !account.hidden;
  checkout.hidden = !account.hidden;
  productsEl.hidden = !account.hidden;
});
document.querySelector("#cartJump").addEventListener("click", () => checkout.scrollIntoView({ behavior: "smooth" }));
document.querySelector("#shopSearch").addEventListener("input", renderProducts);
document.querySelector("#placeOrder").addEventListener("click", placeOrder);
openShop();
