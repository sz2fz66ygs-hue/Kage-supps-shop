const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
const money = value => `£${Number(value || 0).toFixed(2)}`;
let orders = [];
let index = 0;

function showPanel(name) {
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === name));
  document.querySelectorAll("#nav button").forEach(button => button.classList.toggle("active", button.dataset.panel === name));
}

function signedIn() {
  document.querySelector("#login").hidden = true;
  document.querySelector("#nav").hidden = false;
  showPanel("pack");
  loadOrders();
  loadAllOrders();
  loadProducts();
  loadPromos();
  loadAffiliates();
}

function showLogin(text) {
  document.querySelector("#login").hidden = false;
  document.querySelector("#nav").hidden = true;
  document.querySelectorAll(".panel").forEach(panel => panel.classList.remove("active"));
  if (text) message.textContent = text;
}

async function requestCode() {
  const res = await fetch("/api/site/request-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: document.querySelector("#handle").value })
  });
  const data = await res.json();
  message.textContent = data.error || "Code sent in Telegram.";
}

async function verifyCode() {
  const res = await fetch("/api/site/verify-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: document.querySelector("#handle").value, code: document.querySelector("#code").value })
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Code not accepted.");
  if (!data.admin) return (message.textContent = "That Telegram is not an admin.");
  localStorage.setItem(tokenKey, data.token);
  message.textContent = "";
  signedIn();
}

async function loadOrders() {
  const res = await fetch("/api/admin/orders", { headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (!res.ok) return showLogin("Sign in again with an admin Telegram.");
  const data = await res.json();
  orders = data.orders.filter(order => order.fulfilmentStatus !== "packed");
  index = 0;
  renderOrder();
}

function renderOrder() {
  const order = orders[index];
  document.querySelector("#packTitle").textContent = order ? order.dispatch : "All packed";
  document.querySelector("#progress").textContent = orders.length ? `${index + 1} of ${orders.length}` : "";
  const station = document.querySelector("#station");
  if (!order) return (station.innerHTML = `<div class="slip">Nothing left to pack.</div>`);
  station.innerHTML = `<article class="slip">
    <p class="eyebrow">#${order.orderId}</p>
    <h2>${order.customerName || "No name"}</h2>
    <p class="muted">${order.telegram || ""}</p>
    <pre>${order.copyAddress}</pre>
    <div class="items">${order.items.map((item, i) => `<label><input type="checkbox" data-item="${i}"><span>${item}</span></label>`).join("")}</div>
    <button class="gold-btn" id="copyAddress" type="button">Copy address</button>
    <button class="gold-btn" id="copyOrder" type="button">Copy order</button>
    <button class="gold-btn" id="packed" type="button" disabled>Mark packed</button>
    <button class="gold-btn" id="skip" type="button">Skip</button>
    <label>Tracking</label>
    <input id="tracking" placeholder="Tracking number">
    <button class="gold-btn" id="saveTracking" type="button">Save tracking</button>
  </article>`;
  station.querySelectorAll("[data-item]").forEach(box => box.addEventListener("change", () => {
    box.parentElement.classList.toggle("done", box.checked);
    station.querySelector("#packed").disabled = ![...station.querySelectorAll("[data-item]")].every(item => item.checked);
  }));
  station.querySelector("#copyAddress").addEventListener("click", () => navigator.clipboard.writeText(order.copyAddress));
  station.querySelector("#copyOrder").addEventListener("click", () => navigator.clipboard.writeText(order.copyOrder));
  station.querySelector("#packed").addEventListener("click", pack);
  station.querySelector("#skip").addEventListener("click", () => { index = (index + 1) % orders.length; renderOrder(); });
  station.querySelector("#saveTracking").addEventListener("click", saveTracking);
}

async function pack() {
  await fetch(`/api/admin/orders/${orders[index].orderId}/packed`, { method: "POST", headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  renderOrder();
  loadAllOrders();
}

async function saveTracking() {
  await fetch(`/api/admin/orders/${orders[index].orderId}/tracking`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-token": localStorage.getItem(tokenKey) },
    body: JSON.stringify({ tracking: document.querySelector("#tracking").value })
  });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  renderOrder();
  loadAllOrders();
}

async function loadAllOrders() {
  const res = await fetch("/api/admin/all-orders", { headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (!res.ok) return;
  const list = await res.json();
  document.querySelector("#orderList").innerHTML = list.map(order => `<article class="row"><strong>#${order.orderId}</strong><div><strong>${order.customerName || ""}</strong><div class="muted">${order.telegram} · ${order.paymentStatus} · ${order.fulfilmentStatus}${order.dispatch ? ` · ${order.dispatch}` : ""}</div><div>${order.items.join("<br>")}</div></div><strong>${money(order.total)}</strong></article>`).join("") || "<p>No orders.</p>";
}

async function loadProducts() {
  const res = await fetch("/api/site/products");
  const products = await res.json();
  document.querySelector("#productList").innerHTML = products.map(product => `<article class="row"><strong>${product.category}</strong><div><strong>${product.name}</strong><div class="muted">${product.strength}</div></div><div><strong>${money(product.price)}</strong><button data-id="${product.id}" type="button">Remove</button></div></article>`).join("") || "<p>No products yet.</p>";
  document.querySelector("#productList").querySelectorAll("button").forEach(button => button.addEventListener("click", () => removeProduct(button.dataset.id)));
}

async function removeProduct(id) {
  const res = await fetch(`/api/site/products/${id}`, { method: "DELETE", headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (res.status === 401) return showLogin("Sign in again.");
  loadProducts();
}

async function loadPromos() {
  const res = await fetch("/api/admin/promotions", { headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (!res.ok) return;
  const promos = await res.json();
  document.querySelector("#promoList").innerHTML = promos.map(promo => `<article class="row"><strong>#${promo.id}</strong><div><strong>${promo.name}</strong><div class="muted">${promo.rule} · ${promo.productCount} products</div></div><span>${promo.active ? "Active" : "Paused"}</span></article>`).join("") || "<p>No promotions.</p>";
}

async function loadAffiliates() {
  const res = await fetch("/api/admin/affiliates", { headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (!res.ok) return;
  const rows = await res.json();
  document.querySelector("#affiliateList").innerHTML = rows.map(row => `<article class="row"><strong>${row.code}</strong><div><strong>${row.owner}</strong><div class="muted">${row.newCustomers} new customers · earned ${money(row.earned)} · paid ${money(row.paid)}</div></div><strong>${money(row.owed)}</strong></article>`).join("");
}

document.querySelector("#nav").addEventListener("click", event => {
  const button = event.target.closest("[data-panel]");
  if (button) showPanel(button.dataset.panel);
});
document.querySelector("#bulkAdd").addEventListener("click", async () => {
  const text = document.querySelector("#bulk").value.trim();
  if (!text) return (message.textContent = "Paste at least one product.");
  const res = await fetch("/api/site/products/bulk", {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-token": localStorage.getItem(tokenKey) },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (res.status === 401) return showLogin(data.error || "Sign in again.");
  message.textContent = data.error || `Added ${data.added}.${data.failed?.length ? ` Skipped: ${data.failed.join(" | ")}` : ""}`;
  if (res.ok && data.added) document.querySelector("#bulk").value = "";
  loadProducts();
});
document.querySelector("#add").addEventListener("submit", async event => {
  event.preventDefault();
  const res = await fetch("/api/site/products", {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-token": localStorage.getItem(tokenKey) },
    body: JSON.stringify({
      name: document.querySelector("#name").value,
      category: document.querySelector("#category").value,
      strength: document.querySelector("#strength").value,
      price: Number(document.querySelector("#price").value),
      description: document.querySelector("#description").value
    })
  });
  const data = await res.json();
  if (res.status === 401) return showLogin(data.error || "Sign in again.");
  message.textContent = data.error || "Added.";
  if (res.ok) event.target.reset();
  loadProducts();
});
document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
if (localStorage.getItem(tokenKey)) signedIn();
