let products = [];

const grid = document.querySelector("#grid");
const filters = document.querySelector("#filters");
const cartCount = document.querySelector("#cartCount");
const basketLines = document.querySelector("#basketLines");
const basketTotal = document.querySelector("#basketTotal");
const drawer = document.querySelector("#drawer");
const dialog = document.querySelector("#productDialog");
let cart = [];
let active = "All";
let query = "";
let selected = null;

const money = value => `£${Number(value).toFixed(2)}`;
const groups = () => {
  const map = new Map();
  products.filter(product => (active === "All" || product.category === active) && `${product.name} ${product.category}`.toLowerCase().includes(query)).forEach(product => {
    const key = `${product.category}|${product.name}`;
    const group = map.get(key) || { ...product, options: [] };
    group.options.push(product);
    map.set(key, group);
  });
  return [...map.values()];
};

function renderFilters() {
  const categories = ["All", ...new Set(products.map(product => product.category))];
  filters.innerHTML = categories.map(category => `<button class="${category === active ? "active" : ""}" data-category="${category}" type="button">${category}</button>`).join("");
  filters.querySelectorAll("button").forEach(button => button.addEventListener("click", () => { active = button.dataset.category; render(); }));
}

function render() {
  renderFilters();
  grid.innerHTML = groups().map(group => `<article class="card"><img src="${group.image}" alt=""><p class="eyebrow">${group.category}</p><h3>${group.name}</h3><p>${group.description}</p><div class="price">From ${money(Math.min(...group.options.map(option => option.price)))}</div><button class="btn" data-id="${group.options[0].id}" type="button">View</button></article>`).join("") || "<p>Nothing matches.</p>";
  grid.querySelectorAll("[data-id]").forEach(button => button.addEventListener("click", () => openProduct(button.dataset.id)));
}

function openProduct(id) {
  const product = products.find(item => item.id === id);
  const options = products.filter(item => item.name === product.name && item.category === product.category);
  selected = product;
  document.querySelector("#dialogCategory").textContent = product.category;
  document.querySelector("#dialogName").textContent = product.name;
  document.querySelector("#dialogDesc").textContent = product.description;
  document.querySelector("#dialogPrice").textContent = money(product.price);
  document.querySelector("#dialogStrengths").innerHTML = options.map(option => `<button class="${option.id === product.id ? "active" : ""}" data-id="${option.id}" type="button">${option.strength} · ${money(option.price)}</button>`).join("");
  document.querySelector("#dialogStrengths").querySelectorAll("button").forEach(button => button.addEventListener("click", () => openProduct(button.dataset.id)));
  dialog.showModal();
}

function renderCart() {
  cartCount.textContent = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  basketTotal.textContent = money(total);
  basketLines.innerHTML = cart.map(item => `<div>${item.quantity} × ${item.name} (${item.strength}) · ${money(item.price * item.quantity)}</div>`).join("") || "Your basket is empty.";
}

document.querySelector("#dialogAdd").addEventListener("click", () => {
  if (!selected) return;
  const line = cart.find(item => item.id === selected.id);
  if (line) line.quantity += 1;
  else cart.push({ ...selected, quantity: 1 });
  renderCart();
  dialog.close();
  drawer.hidden = false;
});
document.querySelector("#cartOpen").addEventListener("click", () => { drawer.hidden = false; });
document.querySelector("#cartClose").addEventListener("click", () => { drawer.hidden = true; });
document.querySelector("#searchOpen").addEventListener("click", () => { document.querySelector("#searchBar").hidden = !document.querySelector("#searchBar").hidden; });
document.querySelector("#searchInput").addEventListener("input", event => { query = event.target.value.trim().toLowerCase(); render(); });
document.querySelector("#menuOpen").addEventListener("click", () => document.querySelector("#nav").classList.toggle("open"));
document.querySelector("#checkoutBtn").addEventListener("click", () => { window.location.href = "/shop"; });
async function start() {
  const res = await fetch("/api/site/products");
  products = await res.json();
  render();
  renderCart();
}
start();
