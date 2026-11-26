const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
const money = value => `£${Number(value || 0).toFixed(2)}`;
let orders = [];
let index = 0;
let allProducts = [];

function showPanel(name) {
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === name));
  document.querySelectorAll("#nav button").forEach(button => button.classList.toggle("active", button.dataset.panel === name));
  if (name === "raw") loadRaw();
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
  message.textContent = data.error || "Code sent. Check Telegram.";
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

function authHeaders(extra = {}) {
  return { "x-site-token": localStorage.getItem(tokenKey), ...extra };
}

async function loadOrders() {
  const res = await fetch("/api/admin/orders", { headers: authHeaders() });
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
  await fetch(`/api/admin/orders/${orders[index].orderId}/packed`, { method: "POST", headers: authHeaders() });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  renderOrder();
  loadAllOrders();
}

async function saveTracking() {
  await fetch(`/api/admin/orders/${orders[index].orderId}/tracking`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ tracking: document.querySelector("#tracking").value })
  });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  renderOrder();
  loadAllOrders();
}

async function loadAllOrders() {
  const res = await fetch("/api/admin/all-orders", { headers: authHeaders() });
  if (!res.ok) return;
  const list = await res.json();
  document.querySelector("#orderList").innerHTML = list.map(order => `<article class="row"><strong>#${order.orderId}</strong><div><strong>${order.customerName || ""}</strong><div class="muted">${order.telegram} · ${order.paymentStatus} · ${order.fulfilmentStatus}${order.dispatch ? ` · ${order.dispatch}` : ""}</div><div>${order.items.join("<br>")}</div></div><strong>${money(order.total)}</strong></article>`).join("") || "<p>No orders.</p>";
}

async function loadProducts() {
  const res = await fetch("/api/manage/products", { headers: authHeaders() });
  if (!res.ok) return;
  allProducts = await res.json();
  renderProducts();
}

function renderProducts() {
  const list = document.querySelector("#productList");
  list.innerHTML = allProducts.map(p => `
    <article class="slip" data-id="${p.id}">
      <div style="display:flex;justify-content:space-between;align-items:start">
        <div>
          <strong>#${p.id} · ${escapeHtml(p.name)}</strong>
          <div class="muted">${escapeHtml(p.category)} / ${escapeHtml(p.section || "")} · stock ${p.stock} · ${money(p.pricePence / 100)}</div>
        </div>
        <div>
          <button data-edit="${p.id}" type="button">Edit</button>
          <button data-del="${p.id}" type="button" style="color:#a5362f">Delete</button>
        </div>
      </div>
      <div class="product-editor" id="editor-${p.id}" hidden>
        <label>Name</label><input data-field="name" value="${escapeHtml(p.name)}">
        <label>Category</label><input data-field="category" value="${escapeHtml(p.category)}">
        <label>Section</label><input data-field="section" value="${escapeHtml(p.section || "")}">
        <label>Stock</label><input data-field="stock" type="number" value="${p.stock}">
        <label>Unit</label><input data-field="unit" value="${escapeHtml(p.unit || "")}">
        <label>Subtitle</label><textarea data-field="subtitle">${escapeHtml(p.subtitle || "")}</textarea>
        <label>Price (£)</label><input data-field="price" type="number" step="0.01" value="${(p.pricePence / 100).toFixed(2)}">
        <button class="gold-btn" data-save="${p.id}" type="button">Save changes</button>
      </div>
    </article>
  `).join("") || "<p>No products.</p>";

  list.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => {
    const ed = document.querySelector(`#editor-${btn.dataset.edit}`);
    ed.hidden = !ed.hidden;
  }));
  list.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", () => deleteProduct(btn.dataset.del)));
  list.querySelectorAll("[data-save]").forEach(btn => btn.addEventListener("click", () => saveProduct(btn.dataset.save)));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g,"&").replace(/</g,"<").replace(/>/g,">").replace(/"/g,""");
}

async function saveProduct(id) {
  const ed = document.querySelector(`#editor-${id}`);
  const fields = {};
  ed.querySelectorAll("[data-field]").forEach(el => {
    const f = el.dataset.field;
    if (f === "price") fields.pricePence = Math.round(Number(el.value) * 100);
    else if (f === "stock") fields.stock = Number(el.value);
    else fields[f] = el.value;
  });
  const res = await fetch(`/api/manage/products/${id}`, {
    method: "PUT",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(fields)
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Could not save. Try again.");
  message.textContent = "Saved.";
  loadProducts();
}

async function deleteProduct(id) {
  if (!confirm("Delete this product?")) return;
  const res = await fetch(`/api/manage/products/${id}`, { method: "DELETE", headers: authHeaders() });
  if (res.status === 401) return showLogin("Sign in again.");
  loadProducts();
}

document.querySelector("#addProductBtn")?.addEventListener("click", async () => {
  const name = prompt("Product name?");
  if (!name) return;
  const category = prompt("Category?", "Oils") || "Oils";
  const price = Number(prompt("Price in £?", "10")) || 10;
  const res = await fetch("/api/manage/products", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name, category, pricePence: Math.round(price * 100), stock: 10, unit: "units", subtitle: "" })
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Add failed");
  message.textContent = "Added.";
  loadProducts();
});

async function loadRaw() {
  const res = await fetch("/api/manage/products", { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  document.querySelector("#rawJson").value = JSON.stringify(data, null, 2);
}

document.querySelector("#saveRaw")?.addEventListener("click", async () => {
  const text = document.querySelector("#rawJson").value;
  const res = await fetch("/api/manage/products/raw", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ json: text })
  });
  const data = await res.json();
  message.textContent = data.error || `Saved ${data.count} products.`;
  if (res.ok) loadProducts();
});

async function loadPromos() {
  const res = await fetch("/api/admin/promotions", { headers: authHeaders() });
  if (!res.ok) return;
  const promos = await res.json();
  document.querySelector("#promoList").innerHTML = promos.map(promo => `<article class="row"><strong>#${promo.id}</strong><div><strong>${promo.name}</strong><div class="muted">${promo.rule} · ${promo.productCount} products</div></div><span>${promo.active ? "Active" : "Paused"}</span></article>`).join("") || "<p>No promotions.</p>";
}

async function loadAffiliates() {
  const res = await fetch("/api/admin/affiliates", { headers: authHeaders() });
  if (!res.ok) return;
  const rows = await res.json();
  document.querySelector("#affiliateList").innerHTML = rows.map(row => `<article class="row"><strong>${row.code}</strong><div><strong>${row.owner}</strong><div class="muted">${row.newCustomers} new customers · earned ${money(row.earned)} · paid ${money(row.paid)}</div></div><strong>${money(row.owed)}</strong></article>`).join("");
}

document.querySelector("#nav").addEventListener("click", event => {
  const button = event.target.closest("[data-panel]");
  if (button) showPanel(button.dataset.panel);
});

document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
if (localStorage.getItem(tokenKey)) signedIn();
