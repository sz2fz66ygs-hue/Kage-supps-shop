const tokenKey = "kage_site_token";
const message = document.querySelector("#message");
const list = document.querySelector("#list");

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
  localStorage.setItem(tokenKey, data.token);
  document.querySelector("#login").hidden = true;
  document.querySelector("#add").hidden = false;
  load();
}

async function load() {
  const res = await fetch("/api/site/products");
  const products = await res.json();
  list.innerHTML = products.map(product => `<article class="card"><h3>${product.name}</h3><p>${product.category} · ${product.strength} · £${Number(product.price).toFixed(2)}</p><button data-id="${product.id}" type="button">Remove</button></article>`).join("");
  list.querySelectorAll("button").forEach(button => button.addEventListener("click", () => remove(button.dataset.id)));
}

async function remove(id) {
  await fetch(`/api/site/products/${id}`, {
    method: "DELETE",
    headers: { "x-site-token": localStorage.getItem(tokenKey) }
  });
  load();
}

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
  message.textContent = data.error || "Added.";
  if (res.ok) event.target.reset();
  load();
});

document.querySelector("#requestCode").addEventListener("click", requestCode);
document.querySelector("#verifyCode").addEventListener("click", verifyCode);
if (localStorage.getItem(tokenKey)) {
  document.querySelector("#login").hidden = true;
  document.querySelector("#add").hidden = false;
  load();
}
