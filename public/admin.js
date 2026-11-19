const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
let orders = [];
let index = 0;

function showPanel(name) {
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === name));
  document.querySelectorAll("#adminTabs .tab").forEach(tab => tab.classList.toggle("active", tab.dataset.panel === name));
}

function signedIn() {
  document.querySelector("#login").hidden = true;
  document.querySelector("#adminTabs").hidden = false;
  showPanel(location.hash === "#products" ? "products" : "pack");
  loadOrders();
  loadProducts();
}

function showLogin(text) {
  document.querySelector("#login").hidden = false;
  document.querySelector("#adminTabs").hidden = true;
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
  message.textContent = "Signed in.";
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
  document.querySelector("#title").textContent = order ? order.dispatch : "All packed";
  document.querySelector("#progress").textContent = orders.length ? `${index + 1} of ${orders.length}` : "";
  const station = document.querySelector("#station");
  if (!order) return (station.innerHTML = "<p style='padding:16px'>Nothing left to pack.</p>");
  station.innerHTML = `<article class="slip">
    <div class="eyebrow">#${order.orderId}</div>
    <h2>${order.customerName || "No name"}</h2>
    <p>${order.telegram || ""}</p>
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
}

async function loadProducts() {
  const res = await fetch("/api/site/products");
  const products = await res.json();
  document.querySelector("#list").innerHTML = products.map(product => `<article class="card"><h3>${product.name}</h3><p>${product.category} · ${product.strength} · £${Number(product.price).toFixed(2)}</p><button data-id="${product.id}" type="button">Remove</button></article>`).join("") || "<p>No products yet.</p>";
  document.querySelector("#list").querySelectorAll("button").forEach(button => button.addEventListener("click", () => removeProduct(button.dataset.id)));
}

async function removeProduct(id) {
  const res = await fetch(`/api/site/products/${id}`, { method: "DELETE", headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (res.status === 401) return showLogin("Sign in again.");
  loadProducts();
}

document.querySelector("#adminTabs").addEventListener("click", event => {
  const tab = event.target.closest("[data-panel]");
  if (tab) showPanel(tab.dataset.panel);
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
