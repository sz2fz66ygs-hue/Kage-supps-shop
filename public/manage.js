const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
const list = document.querySelector("#list");

function showLogin(text) {
  document.querySelector("#login").hidden = false;
  document.querySelector("#tools").hidden = true;
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
    body: JSON.stringify({
      handle: document.querySelector("#handle").value,
      code: document.querySelector("#code").value
    })
  });
  const data = await res.json();
  if (!res.ok) return (message.textContent = data.error || "Code not accepted.");
  if (!data.admin) return (message.textContent = "That Telegram is not an admin.");
  localStorage.setItem(tokenKey, data.token);
  document.querySelector("#login").hidden = true;
  document.querySelector("#tools").hidden = false;
  message.textContent = "Signed in.";
  load();
}

async function load() {
  const res = await fetch("/api/site/products");
  const products = await res.json();
  list.innerHTML = products.map(product => `<article class="card"><h3>${product.name}</h3><p>${product.category} · ${product.strength} · £${Number(product.price).toFixed(2)}</p><button data-id="${product.id}" type="button">Remove</button></article>`).join("") || "<p>No products yet.</p>";
  list.querySelectorAll("button").forEach(button => button.addEventListener("click", () => remove(button.dataset.id)));
}

async function remove(id) {
  const res = await fetch(`/api/site/products/${id}`, {
    method: "DELETE",
    headers: { "x-site-token": localStorage.getItem(tokenKey) }
  });
  if (res.status === 401) return showLogin("Sign in again.");
  load();
}

document.querySelector("#bulkAdd").addEventListener("click", async () => {
  const text = document.querySelector("#bulk").value.trim();
  if (!text) return (message.textContent = "Paste at least one product.");
  const res = await fetch("/api/site/products/bulk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-site-token": localStorage.getItem(tokenKey)
    },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (res.status === 401) return showLogin(data.error || "Sign in again.");
  message.textContent = data.error || `Added ${data.added}.${data.failed?.length ? ` Skipped: ${data.failed.join(" | ")}` : ""}`;
  if (res.ok && data.added) document.querySelector("#bulk").value = "";
  load();
});

document.querySelector("#add").addEventListener("submit", async event => {
  event.preventDefault();
  const res = await fetch("/api/site/products", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-site-token": localStorage.getItem(tokenKey)
    },
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
  load();
});

document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
if (localStorage.getItem(tokenKey)) {
  document.querySelector("#login").hidden = true;
  document.querySelector("#tools").hidden = false;
  load();
}
