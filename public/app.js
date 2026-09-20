const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// Telegram gives the Mini App the opener's real id/username when it's
// launched from the bot (not cryptographically verified client-side, but
// far more reliable than asking the buyer to type their own handle).
const telegramUser = tg?.initDataUnsafe?.user || null;

/* =========================================================
   KAGE SUPPS — PRODUCT CATALOGUE

   Every product lives in /public/products.json — the server reads
   that exact same file to validate prices and stock, so a client
   can never submit its own price or exceed stock. Every product in
   it automatically gets add/remove-to-basket controls; there is no
   separate "display-only" list.
   ========================================================= */


const categories = [
  { name: "Oils", icon: "🛢️" },
  { name: "Orals", icon: "💪" },
  { name: "Pharma", icon: "💊" },
  { name: "Peps", icon: "⚡" }
];



const sectionOrder = {
  Oils: [
    "Oils",
    "Pre-Workout Injectables",
    "Blends"
  ],

  Orals: [
    "Tubs",
    "Coming Soon — Pouches"
  ],

  Pharma: [
    "Cardiovascular",
    "Metabolic",
    "Hormones & Related",
    "Sleep",
    "Neurology & Wakefulness",
    "Sexual Health",
    "Hair & Skin",
    "Other Pharma"
  ],

  Peps: [
    "Recovery Research",
    "Metabolic Research",
    "Copper Peptide",
    "Other Peptides",
    "Supplies"
  ]
};

let products = [];

const basket = {};
let currentCategory = categories[0].name;
let appliedCode = null; // { code, discountType, discountValue } once validated by the server
let appliedStoreCredit = null; // { code, balancePence } once validated by the server

const money = p => `£${(p / 100).toFixed(2)}`;

// Best-effort basket telemetry for the admin's weekly summary. Never blocks
// the UI and failures are silently ignored.
function postCartEvent(productId, action) {
  fetch("/api/cart-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, action })
  }).catch(() => {});
}

function stockBadge(stock, unit = "items") {
  if (stock === null || stock === undefined) {
    return `<span class="stock low">Stock not entered</span>`;
  }

  if (stock <= 0) {
    return `<span class="stock out">Out of stock</span>`;
  }

  if (stock <= 10) {
    return `<span class="stock low">${stock} ${unit} left</span>`;
  }

  return `<span class="stock good">${stock} ${unit} in stock</span>`;
}

function renderTabs() {
  document.getElementById("tabs").innerHTML = categories.map(c => `
    <button
      class="tab ${c.name === currentCategory ? "active" : ""}"
      data-category="${c.name}"
    >
      ${c.name} ${c.icon}
    </button>
  `).join("");

  document.querySelectorAll("[data-category]").forEach(btn => {
    btn.addEventListener("click", () => {
      currentCategory = btn.dataset.category;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

function shopCard(p) {
  const qty = basket[p.id] || 0;

  return `
    <div class="product">
      <div>
        <h3>${p.name}</h3>
        ${p.subtitle ? `<div class="sub">${p.subtitle}</div>` : ""}
        ${stockBadge(p.stock, p.unit)}
      </div>

      <div>
        <div class="price">${money(p.pricePence)}</div>

        <div class="qty">
          <button
            data-id="${p.id}"
            data-d="-1"
            ${qty === 0 ? "disabled" : ""}
          >
            −
          </button>

          <span>${qty}</span>

          <button
            data-id="${p.id}"
            data-d="1"
            ${qty >= p.stock ? "disabled" : ""}
          >
            +
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderProducts() {
  let html = "";

  (sectionOrder[currentCategory] || []).forEach(section => {
    const shopItems = products.filter(
      p => p.category === currentCategory && p.section === section
    );

    html += `<div class="section-title">${section}</div>`;

    if (!shopItems.length) {
      html += `<div class="empty">No products added yet.</div>`;
    } else {
      html += shopItems.map(shopCard).join("");
    }
  });

  document.getElementById("products").innerHTML = html;

  document.querySelectorAll("[data-d]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const delta = Number(btn.dataset.d);
      const product = products.find(p => p.id === id);

      if (!product) return;

      const current = basket[id] || 0;
      const next = Math.max(
        0,
        Math.min(product.stock, current + delta)
      );

      if (next === 0) {
        delete basket[id];
        if (current > 0) postCartEvent(id, "remove");
      } else {
        basket[id] = next;
        if (current === 0) postCartEvent(id, "add");
      }

      tg?.HapticFeedback?.selectionChanged();
      render();
    });
  });
}

function basketCount() {
  return Object.values(basket).reduce((sum, qty) => sum + qty, 0);
}

function basketSubtotalValue() {
  return Object.entries(basket).reduce((sum, [id, qty]) => {
    const product = products.find(p => p.id === Number(id));
    return sum + (product ? product.pricePence * qty : 0);
  }, 0);
}

function discountForSubtotal(subtotalPence) {
  if (!appliedCode) return 0;

  const raw = appliedCode.discountType === "percent"
    ? Math.round(subtotalPence * (appliedCode.discountValue / 100))
    : appliedCode.discountValue;

  return Math.min(raw, subtotalPence);
}

function storeCreditForRemaining(remainingPence) {
  if (!appliedStoreCredit) return 0;
  return Math.min(appliedStoreCredit.balancePence, remainingPence);
}

function basketTotalValue() {
  const subtotal = basketSubtotalValue();
  const discount = discountForSubtotal(subtotal);
  const credit = storeCreditForRemaining(subtotal - discount);
  return Math.max(0, subtotal - discount - credit);
}

function renderBasket() {
  const basketLines = document.getElementById("basketLines");
  const basketTotal = document.getElementById("basketTotal");
  const cartCount = document.getElementById("cartCount");
  const discountRow = document.getElementById("discountRow");
  const creditRow = document.getElementById("creditRow");
  const entries = Object.entries(basket);
  const subtotal = basketSubtotalValue();
  const discount = discountForSubtotal(subtotal);
  const credit = storeCreditForRemaining(subtotal - discount);

  if (cartCount) {
    cartCount.textContent = basketCount();
  }

  if (basketTotal) {
    basketTotal.textContent = money(Math.max(0, subtotal - discount - credit));
  }

  if (discountRow) {
    discountRow.innerHTML = discount > 0
      ? `<div class="discount-line">Code <strong>${appliedCode.code}</strong> applied: −${money(discount)}</div>`
      : "";
  }

  if (creditRow) {
    creditRow.innerHTML = credit > 0
      ? `<div class="discount-line">Store credit <strong>${appliedStoreCredit.code}</strong> applied: −${money(credit)}</div>`
      : "";
  }

  if (!basketLines) return;

  if (!entries.length) {
    basketLines.innerHTML = `<div class="empty">Your basket is empty.</div>`;
    return;
  }

  basketLines.innerHTML = entries.map(([id, qty]) => {
    const p = products.find(x => x.id === Number(id));

    return `
      <div class="basket-line">
        <div>
          <strong>${p.name}</strong><br>
          <span>${qty} × ${money(p.pricePence)}</span>
        </div>

        <div class="basket-right">
          <strong>${money(p.pricePence * qty)}</strong>
          <button data-remove="${p.id}">Remove</button>
        </div>
      </div>
    `;
  }).join("");

  document.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.remove);
      delete basket[id];
      postCartEvent(id, "remove");
      tg?.HapticFeedback?.selectionChanged();
      render();
    });
  });
}

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
}

async function loadProducts() {
  try {
    const res = await fetch("/products.json");
    products = await res.json();
  } catch (err) {
    console.error("Failed to load products", err);
    products = [];
  }
  render();
}

function setStatus(message, kind = "") {
  const status = document.getElementById("status");
  if (!status) return;
  status.textContent = message;
  status.className = `status ${kind}`;
}

async function applyDiscountCode() {
  const input = document.getElementById("discountCode");
  const code = input?.value.trim();

  if (!code) {
    appliedCode = null;
    renderBasket();
    return;
  }

  try {
    const params = new URLSearchParams();
    if (telegramUser?.id) params.set("telegramId", telegramUser.id);
    if (telegramUser?.username) params.set("telegramUsername", telegramUser.username);

    const res = await fetch(`/api/discount-codes/${encodeURIComponent(code)}?${params.toString()}`);
    const data = await res.json();

    if (!res.ok || !data.valid) {
      appliedCode = null;
      renderBasket();
      setStatus(data.error || "That code isn't valid.", "error");
      return;
    }

    appliedCode = {
      code: data.code,
      discountType: data.discountType,
      discountValue: data.discountValue
    };

    setStatus("Code applied!", "success");
    renderBasket();
  } catch (err) {
    setStatus("Couldn't check that code, try again.", "error");
  }
}

async function applyStoreCredit() {
  const input = document.getElementById("storeCreditCode");
  const code = input?.value.trim();

  if (!code) {
    appliedStoreCredit = null;
    renderBasket();
    return;
  }

  try {
    const res = await fetch(`/api/referral-codes/${encodeURIComponent(code)}/earnings`);
    const data = await res.json();

    if (!res.ok) {
      appliedStoreCredit = null;
      renderBasket();
      setStatus(data.error || "That code isn't valid.", "error");
      return;
    }

    if (!data.balancePence || data.balancePence <= 0) {
      appliedStoreCredit = null;
      renderBasket();
      setStatus("No store credit available on that code.", "error");
      return;
    }

    appliedStoreCredit = { code: data.code, balancePence: data.balancePence };
    setStatus(`Store credit applied: ${money(data.balancePence)} available!`, "success");
    renderBasket();
  } catch (err) {
    setStatus("Couldn't check that code, try again.", "error");
  }
}

async function submitOrder() {
  const customerName = document.getElementById("name")?.value.trim();
  const telegramUsername = telegramUser?.username || document.getElementById("handle")?.value.trim();
  const telegramId = telegramUser?.id || undefined;
  const address = document.getElementById("address")?.value.trim();
  const items = Object.entries(basket).map(([id, quantity]) => ({
    id: Number(id),
    quantity
  }));

  if (!items.length) {
    setStatus("Your basket is empty.", "error");
    return;
  }

  if (!customerName || !address) {
    setStatus("Please add your name and delivery address.", "error");
    return;
  }

  const checkoutBtn = document.getElementById("checkoutBtn");
  if (checkoutBtn) checkoutBtn.disabled = true;
  setStatus("Placing your order…");

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName,
        telegramUsername,
        telegramId,
        address,
        items,
        discountCode: appliedCode?.code || undefined,
        storeCreditCode: appliedStoreCredit?.code || undefined
      })
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Something went wrong placing your order.", "error");
      return;
    }

    setStatus(`Order #${data.orderId} created — total ${money(data.totalPence)}.`, "success");
    Object.keys(basket).forEach(id => delete basket[id]);
    appliedCode = null;
    appliedStoreCredit = null;
    if (document.getElementById("discountCode")) document.getElementById("discountCode").value = "";
    if (document.getElementById("storeCreditCode")) document.getElementById("storeCreditCode").value = "";
    render();
    renderPaymentPanel(data);
  } catch (err) {
    setStatus("Couldn't reach the server, try again.", "error");
  } finally {
    if (checkoutBtn) checkoutBtn.disabled = false;
  }
}

function renderPaymentPanel(order) {
  const panel = document.getElementById("paymentPanel");
  if (!panel) return;

  if (!order.payment || order.payment.method !== "crypto") {
    panel.innerHTML = "";
    return;
  }

  panel.innerHTML = `
    <div class="payment-panel">
      <div class="payment-title">Send USDT (ERC-20, Ethereum mainnet) to</div>
      <div class="payment-address">${order.payment.address}</div>
      <div class="payment-quote">≈ ${order.payment.quote.USDT} USDT</div>
      <div class="payment-sub">${order.payment.instructions}</div>

      <label>Transaction hash</label>
      <input id="paymentTxId" placeholder="0x...">

      <button id="confirmPaymentBtn" class="gold-btn" type="button">I've paid — confirm</button>
      <div id="paymentStatus" class="status"></div>
    </div>
  `;

  document.getElementById("confirmPaymentBtn")?.addEventListener("click", () => confirmPayment(order.orderId));
}

async function confirmPayment(orderId) {
  const transactionId = document.getElementById("paymentTxId")?.value.trim();
  const paymentStatus = document.getElementById("paymentStatus");

  const setPaymentStatus = (message, kind = "") => {
    if (!paymentStatus) return;
    paymentStatus.textContent = message;
    paymentStatus.className = `status ${kind}`;
  };

  if (!transactionId) {
    setPaymentStatus("Enter your transaction hash.", "error");
    return;
  }

  const btn = document.getElementById("confirmPaymentBtn");
  if (btn) btn.disabled = true;
  setPaymentStatus("Checking the blockchain…");

  try {
    const res = await fetch(`/api/orders/${orderId}/confirm-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId })
    });

    const data = await res.json();

    if (!res.ok) {
      setPaymentStatus(data.error || "Could not confirm payment.", "error");
      return;
    }

    setPaymentStatus("Payment confirmed! We're preparing your shipment.", "success");
  } catch (err) {
    setPaymentStatus("Couldn't reach the server, try again.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

if (telegramUser?.username) {
  const handleInput = document.getElementById("handle");
  if (handleInput) {
    handleInput.value = `@${telegramUser.username}`;
    handleInput.disabled = true;
  }
}

document.getElementById("applyDiscount")?.addEventListener("click", applyDiscountCode);
document.getElementById("applyStoreCredit")?.addEventListener("click", applyStoreCredit);
document.getElementById("checkoutBtn")?.addEventListener("click", submitOrder);
document.getElementById("cartJump")?.addEventListener("click", () => {
  document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" });
});

loadProducts();