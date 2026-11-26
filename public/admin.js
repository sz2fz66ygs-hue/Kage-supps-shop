const tokenKey = "kage_admin_token";
const message = document.querySelector("#message");
const money = v => `£${Number(v || 0).toFixed(2)}`;

function showPanel(name) {
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === name));
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.panel === name));
  if (name === "dashboard") loadDashboard();
  if (name === "products") loadProducts();
  if (name === "orders") loadOrders();
  if (name === "customers") loadCustomers();
  if (name === "settings") loadSettings();
  if (name === "promos") loadPromos();
  if (name === "raw") loadRaw();
  if (name === "admins") loadAdmins();
}

function signedIn() {
  document.querySelector("#login").hidden = true;
  document.querySelector("#nav").hidden = false;
  showPanel("dashboard");
}

function showLogin(text) {
  document.querySelector("#login").hidden = false;
  document.querySelector("#nav").hidden = true;
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  if (text) message.textContent = text;
}

function authHeaders(extra = {}) {
  return { "x-admin-token": localStorage.getItem(tokenKey), ...extra };
}

async function adminRequest() {
  const phone = document.querySelector("#adminPhone").value.trim();
  const res = await fetch("/api/admin/request-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone })
  });
  const data = await res.json();
  message.textContent = data.error || "Code sent by SMS.";
}

async function adminVerify() {
  const phone = document.querySelector("#adminPhone").value.trim();
  const code = document.querySelector("#adminCode").value.trim();
  const res = await fetch("/api/admin/verify-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, code })
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Code not accepted.");
  localStorage.setItem(tokenKey, data.token);
  message.textContent = "";
  signedIn();
}

async function loadDashboard() {
  const res = await fetch("/api/admin/dashboard", { headers: authHeaders() });
  if (!res.ok) return showLogin("Sign in again.");
  const d = await res.json();
  document.querySelector("#stats").innerHTML = `
    <article class="slip"><strong>Orders today</strong><div class="muted">${d.ordersToday ?? 0}</div></article>
    <article class="slip"><strong>Pending payment</strong><div class="muted">${d.pending ?? 0}</div></article>
    <article class="slip"><strong>Verified customers</strong><div class="muted">${d.customers ?? 0}</div></article>
    <article class="slip"><strong>Products</strong><div class="muted">${d.products ?? 0}</div></article>
  `;
}

async function loadProducts() {
  const res = await fetch("/api/manage/products", { headers: authHeaders() });
  if (!res.ok) return;
  const products = await res.json();
  document.querySelector("#productList").innerHTML = products.map(p => `
    <article class="slip">
      <strong>#${p.id} · ${p.name}</strong>
      <div class="muted">${p.category} · stock ${p.stock} · ${money(p.pricePence/100)}</div>
      <button data-edit="${p.id}" type="button">Edit</button>
      <button data-del="${p.id}" type="button" style="color:#a5362f">Delete</button>
      <div class="product-editor" id="ed-${p.id}" hidden>
        <input data-f="name" value="${p.name||""}">
        <input data-f="category" value="${p.category||""}">
        <input data-f="stock" type="number" value="${p.stock||0}">
        <input data-f="price" type="number" step="0.01" value="${((p.pricePence||0)/100).toFixed(2)}">
        <textarea data-f="subtitle">${p.subtitle||""}</textarea>
        <button class="gold-btn" data-save="${p.id}" type="button">Save</button>
      </div>
    </article>
  `).join("") || "<p>No products.</p>";
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const ed = document.getElementById("ed-" + b.dataset.edit);
    ed.hidden = !ed.hidden;
  });
  document.querySelectorAll("[data-del]").forEach(b => b.onclick = () => deleteProduct(b.dataset.del));
  document.querySelectorAll("[data-save]").forEach(b => b.onclick = () => saveProduct(b.dataset.save));
}

async function saveProduct(id) {
  const ed = document.getElementById("ed-" + id);
  const body = {};
  ed.querySelectorAll("[data-f]").forEach(el => {
    const f = el.dataset.f;
    if (f === "price") body.pricePence = Math.round(Number(el.value) * 100);
    else if (f === "stock") body.stock = Number(el.value);
    else body[f] = el.value;
  });
  const res = await fetch(`/api/manage/products/${id}`, {
    method: "PUT",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  message.textContent = data.error || "Saved.";
  if (res.ok) loadProducts();
}

async function deleteProduct(id) {
  if (!confirm("Delete?")) return;
  await fetch(`/api/manage/products/${id}`, { method: "DELETE", headers: authHeaders() });
  loadProducts();
}

document.querySelector("#addProductBtn")?.addEventListener("click", async () => {
  const name = prompt("Name?");
  if (!name) return;
  const price = Number(prompt("Price £?", "10")) || 10;
  await fetch("/api/manage/products", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ name, category: "General", pricePence: Math.round(price*100), stock: 10 })
  });
  loadProducts();
});

async function loadOrders() {
  const res = await fetch("/api/admin/all-orders", { headers: authHeaders() });
  if (!res.ok) return;
  const list = await res.json();
  document.querySelector("#orderList").innerHTML = list.map(o => `
    <article class="row">
      <strong>#${o.orderId}</strong>
      <div><strong>${o.customerName||""}</strong><div class="muted">${o.paymentStatus} · ${o.fulfilmentStatus}</div></div>
      <strong>${money(o.total)}</strong>
    </article>
  `).join("") || "<p>No orders.</p>";
}

async function loadCustomers() {
  const res = await fetch("/api/admin/customers", { headers: authHeaders() });
  if (!res.ok) return;
  const rows = await res.json();
  document.querySelector("#customerList").innerHTML = rows.map(c => `
    <article class="row">
      <strong>${c.phone || c.telegram || c.id}</strong>
      <div class="muted">${c.verified ? "Verified" : "Pending"} · ${c.method||""}</div>
      <button data-verify="${c.id}" type="button">${c.verified ? "Unverify" : "Verify"}</button>
    </article>
  `).join("") || "<p>No customers yet.</p>";
  document.querySelectorAll("[data-verify]").forEach(b => b.onclick = () => toggleVerify(b.dataset.verify));
}

async function toggleVerify(id) {
  await fetch(`/api/admin/customers/${id}/toggle`, { method: "POST", headers: authHeaders() });
  loadCustomers();
}

async function loadSettings() {
  const res = await fetch("/api/admin/settings", { headers: authHeaders() });
  if (!res.ok) return;
  const s = await res.json();
  document.querySelector("#minOrder").value = s.minOrder ?? 50;
  document.querySelector("#storeNotice").value = s.notice || "";
}

document.querySelector("#saveMinOrder")?.addEventListener("click", async () => {
  const minOrder = Number(document.querySelector("#minOrder").value);
  await fetch("/api/admin/settings", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ minOrder })
  });
  message.textContent = "Minimum order saved.";
});

document.querySelector("#saveNotice")?.addEventListener("click", async () => {
  const notice = document.querySelector("#storeNotice").value;
  await fetch("/api/admin/settings", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ notice })
  });
  message.textContent = "Notice saved.";
});

document.querySelector("#saveSms")?.addEventListener("click", async () => {
  const body = {
    twilioSid: document.querySelector("#twilioSid").value,
    twilioToken: document.querySelector("#twilioToken").value,
    twilioFrom: document.querySelector("#twilioFrom").value
  };
  await fetch("/api/admin/sms-settings", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  message.textContent = "SMS settings saved.";
});

async function loadPromos() {
  const res = await fetch("/api/admin/promotions", { headers: authHeaders() });
  if (!res.ok) return;
  const promos = await res.json();
  document.querySelector("#promoList").innerHTML = promos.map(p => `<article class="row"><strong>${p.name||p.code}</strong><div class="muted">${p.active?"Active":"Paused"}</div></article>`).join("") || "<p>No promotions.</p>";
}

async function loadRaw() {
  const res = await fetch("/api/manage/products", { headers: authHeaders() });
  if (!res.ok) return;
  document.querySelector("#rawJson").value = JSON.stringify(await res.json(), null, 2);
}

document.querySelector("#saveRaw")?.addEventListener("click", async () => {
  const res = await fetch("/api/manage/products/raw", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ json: document.querySelector("#rawJson").value })
  });
  const data = await res.json();
  message.textContent = data.error || `Saved ${data.count} products.`;
});

document.querySelector("#nav").addEventListener("click", e => {
  const b = e.target.closest("[data-panel]");
  if (b) showPanel(b.dataset.panel);
});
document.querySelector("#adminRequest").addEventListener("click", adminRequest);
document.querySelector("#adminVerify").addEventListener("click", adminVerify);
if (localStorage.getItem(tokenKey)) signedIn();

async function loadAdmins() {
  const res = await fetch("/api/admin/admins", { headers: authHeaders() });
  if (!res.ok) return;
  const rows = await res.json();
  document.querySelector("#adminList").innerHTML = rows.map(a => `
    <article class="row">
      <strong>${a.phone}</strong>
      <div class="muted">Admin</div>
      <button data-remove-admin="${a.phone}" type="button" style="color:#a5362f">Remove</button>
    </article>
  `).join("") || "<p>No admins yet.</p>";
  document.querySelectorAll("[data-remove-admin]").forEach(b => b.onclick = () => removeAdmin(b.dataset.removeAdmin));
}

async function addAdmin() {
  const phone = document.querySelector("#newAdminPhone").value.trim();
  if (!phone) return;
  const res = await fetch("/api/admin/admins", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ phone })
  });
  const data = await res.json();
  message.textContent = data.error || "Admin added.";
  document.querySelector("#newAdminPhone").value = "";
  loadAdmins();
}

async function removeAdmin(phone) {
  if (!confirm("Remove this admin?")) return;
  await fetch("/api/admin/admins/" + encodeURIComponent(phone), { method: "DELETE", headers: authHeaders() });
  loadAdmins();
}

document.querySelector("#addAdminBtn")?.addEventListener("click", addAdmin);

async function adminPasskeyLogin() {
  const phone = document.querySelector("#adminPhone").value.trim();
  const passkey = document.querySelector("#adminPasskey").value;
  const res = await fetch("/api/admin/passkey-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, passkey })
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Passkey not accepted.");
  localStorage.setItem(tokenKey, data.token);
  message.textContent = "";
  signedIn();
}
document.querySelector("#adminPasskeyLogin")?.addEventListener("click", adminPasskeyLogin);
