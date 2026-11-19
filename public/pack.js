const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
const station = document.querySelector("#station");
let orders = [];
let index = 0;

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
  document.querySelector("#login").hidden = true;
  station.hidden = false;
  await load();
}

async function load() {
  const res = await fetch("/api/admin/orders", { headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  if (!res.ok) {
    document.querySelector("#login").hidden = false;
    station.hidden = true;
    return (message.textContent = "Sign in again with an admin Telegram.");
  }
  const data = await res.json();
  orders = data.orders.filter(order => order.fulfilmentStatus !== "packed");
  index = 0;
  render();
}

function render() {
  const order = orders[index];
  document.querySelector("#title").textContent = order ? order.dispatch : "All packed";
  document.querySelector("#progress").textContent = orders.length ? `${index + 1} of ${orders.length}` : "";
  if (!order) {
    station.innerHTML = "<p>Nothing left to pack.</p>";
    return;
  }
  station.innerHTML = `<article class="slip">
    <div class="eyebrow">#${order.orderId}</div>
    <h2>${order.customerName || "No name"}</h2>
    <p>${order.telegram || ""}</p>
    <pre>${order.copyAddress}</pre>
    <div class="items">${order.items.map((item, i) => `<label><input type="checkbox" data-item="${i}"><span>${item}</span></label>`).join("")}</div>
    <div class="actions">
      <button class="gold-btn" id="copyAddress" type="button">Copy address</button>
      <button class="gold-btn" id="copyOrder" type="button">Copy order</button>
      <button class="gold-btn" id="packed" type="button" disabled>Mark packed</button>
      <button class="gold-btn" id="skip" type="button">Skip</button>
    </div>
    <label>Tracking</label>
    <input id="tracking" placeholder="Tracking number">
    <button class="gold-btn" id="saveTracking" type="button">Save tracking</button>
  </article>`;
  station.querySelectorAll("[data-item]").forEach(box => box.addEventListener("change", () => {
    box.parentElement.classList.toggle("done", box.checked);
    const all = [...station.querySelectorAll("[data-item]")].every(item => item.checked);
    station.querySelector("#packed").disabled = !all;
  }));
  station.querySelector("#copyAddress").addEventListener("click", () => navigator.clipboard.writeText(order.copyAddress));
  station.querySelector("#copyOrder").addEventListener("click", () => navigator.clipboard.writeText(order.copyOrder));
  station.querySelector("#packed").addEventListener("click", pack);
  station.querySelector("#skip").addEventListener("click", () => { index = (index + 1) % orders.length; render(); });
  station.querySelector("#saveTracking").addEventListener("click", saveTracking);
}

async function pack() {
  const order = orders[index];
  await fetch(`/api/admin/orders/${order.orderId}/packed`, { method: "POST", headers: { "x-site-token": localStorage.getItem(tokenKey) } });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  render();
}

async function saveTracking() {
  const order = orders[index];
  await fetch(`/api/admin/orders/${order.orderId}/tracking`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-token": localStorage.getItem(tokenKey) },
    body: JSON.stringify({ tracking: station.querySelector("#tracking").value })
  });
  orders.splice(index, 1);
  if (index >= orders.length) index = 0;
  render();
}

document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
if (localStorage.getItem(tokenKey)) {
  document.querySelector("#login").hidden = true;
  station.hidden = false;
  load();
}
