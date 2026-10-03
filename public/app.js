const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const telegramUser = tg?.initDataUnsafe?.user || null;

const preferredCategoryOrder = ["Oils", "Orals", "Pharma", "Peps"];
const categoryIcons = {
  Oils: "🛢️",
  Orals: "💪",
  Pharma: "💊",
  Peps: "⚡"
};

const preferredSectionOrder = {
  Oils: ["Pre-Workout", "Oils", "Blends"],
  Orals: ["Orals"],
  Pharma: ["General Pharma"],
  Peps: ["Recovery", "Performance", "Weight Management", "Other"]
};

let products = [];
let categories = [];
let sectionOrder = {};

const basket = {};
let currentCategory = null;
let appliedCode = null;
let appliedStorewideCode = null;
let appliedStoreCredit = null;

const money = p => `£${(Number(p || 0) / 100).toFixed(2)}`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rebuildCatalogueNavigation() {
  const foundCategories = [...new Set(
    products
      .map(p => String(p.category || "Other").trim() || "Other")
  )];

  const ordered = [
    ...preferredCategoryOrder.filter(name => foundCategories.includes(name)),
    ...foundCategories.filter(name => !preferredCategoryOrder.includes(name))
  ];

  categories = ordered.map(name => ({
    name,
    icon: categoryIcons[name] || "•"
  }));

  sectionOrder = {};

  for (const category of ordered) {
    const foundSections = [...new Set(
      products
        .filter(p => String(p.category || "Other").trim() === category)
        .map(p => String(p.section || "Other").trim() || "Other")
    )];

    const preferred = preferredSectionOrder[category] || [];
    sectionOrder[category] = [
      ...preferred.filter(name => foundSections.includes(name)),
      ...foundSections.filter(name => !preferred.includes(name))
    ];
  }

  if (!currentCategory || !ordered.includes(currentCategory)) {
    currentCategory = ordered[0] || null;
  }
}

function postCartEvent(productId, action) {
  fetch("/api/cart-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId, action })
  }).catch(() => {});
}

function stockBadge(stock, unit = "items") {
  if (stock === null || stock === undefined || Number.isNaN(Number(stock))) {
    return `<span class="stock low">Stock not entered</span>`;
  }

  const n = Number(stock);

  if (n <= 0) {
    return `<span class="stock out">Out of stock</span>`;
  }

  if (n <= 10) {
    return `<span class="stock low">${n} ${escapeHtml(unit)} left</span>`;
  }

  return `<span class="stock good">${n} ${escapeHtml(unit)} in stock</span>`;
}

function renderTabs() {
  const tabs = document.getElementById("tabs");
  if (!tabs) return;

  tabs.innerHTML = categories.map(c => `
    <button
      class="tab ${c.name === currentCategory ? "active" : ""}"
      data-category="${escapeHtml(c.name)}"
      type="button"
    >
      ${c.icon} ${escapeHtml(c.name)}
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
  const id = Number(p.id);
  const qty = basket[id] || 0;
  const shownPricePence = Number(p.displayPricePence ?? p.pricePence);
  const truePricePence = Number(p.pricePence);
  const stock = Number(p.stock ?? 0);
  const canPurchase =
    p.purchasable !== false &&
    Number.isFinite(truePricePence) &&
    truePricePence >= 0;

  const priceText = Number.isFinite(shownPricePence)
    ? money(shownPricePence)
    : "";

  return `
    <div class="product">
      <div>
        <h3>${escapeHtml(p.name)}</h3>
        ${p.subtitle ? `<div class="sub">${escapeHtml(p.subtitle)}</div>` : ""}
        ${stockBadge(p.stock, p.unit)}
      </div>

      <div>
        <div class="price">${priceText}</div>

        ${canPurchase ? `
          <div class="qty">
            <button
              data-id="${id}"
              data-d="-1"
              type="button"
              ${qty === 0 ? "disabled" : ""}
            >−</button>

            <span>${qty}</span>

            <button
              data-id="${id}"
              data-d="1"
              type="button"
              ${qty >= stock ? "disabled" : ""}
            >+</button>
          </div>
        ` : ""}
      </div>
    </div>
  `;
}

function renderProducts() {
  const container = document.getElementById("products");
  if (!container) return;

  if (!products.length) {
    container.innerHTML = `
      <div class="catalogue-error">
        No products could be loaded. Please refresh the shop.
      </div>
    `;
    return;
  }

  if (!currentCategory) {
    container.innerHTML = products.map(shopCard).join("");
    return;
  }

  const sections = sectionOrder[currentCategory] || [];
  let html = "";

  for (const section of sections) {
    const shopItems = products.filter(
      p => String(p.category || "Other").trim() === currentCategory &&
           String(p.section || "Other").trim() === section
    );

    if (!shopItems.length) continue;

    html += `<div class="section-title">${escapeHtml(section)}</div>`;
    html += shopItems.map(shopCard).join("");
  }

  if (!html) {
    const fallback = products.filter(
      p => String(p.category || "Other").trim() === currentCategory
    );
    html = fallback.map(shopCard).join("");
  }

  container.innerHTML = html;

  document.querySelectorAll("[data-d]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.id);
      const delta = Number(btn.dataset.d);
      const product = products.find(p => Number(p.id) === id);

      if (!product) return;

      const stock = Math.max(0, Number(product.stock || 0));
      const current = basket[id] || 0;
      const next = Math.max(0, Math.min(stock, current + delta));

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
  return Object.values(basket).reduce((sum, qty) => sum + Number(qty || 0), 0);
}

function basketSubtotalValue() {
  return Object.entries(basket).reduce((sum, [id, qty]) => {
    const product = products.find(p => Number(p.id) === Number(id));
    const price = Number(product?.pricePence);
    return sum + (product && Number.isFinite(price) ? price * Number(qty) : 0);
  }, 0);
}

function discountForSubtotal(subtotalPence) {
  if (!appliedCode) return 0;

  const raw = appliedCode.discountType === "percent"
    ? Math.round(subtotalPence * (Number(appliedCode.discountValue) / 100))
    : Number(appliedCode.discountValue || 0);

  return Math.min(Math.max(0, raw), subtotalPence);
}

function storewideDiscountForSubtotal(subtotalPence) {
  if (!appliedStorewideCode) return 0;

  const raw = Math.round(
    subtotalPence * (Number(appliedStorewideCode.discountPercent || 0) / 100)
  );

  return Math.min(Math.max(0, raw), subtotalPence);
}

function storeCreditForRemaining(remainingPence) {
  if (!appliedStoreCredit) return 0;
  return Math.min(
    Math.max(0, Number(appliedStoreCredit.balancePence || 0)),
    Math.max(0, remainingPence)
  );
}

function renderBasket() {
  const basketLines = document.getElementById("basketLines");
  const basketTotal = document.getElementById("basketTotal");
  const cartCount = document.getElementById("cartCount");
  const discountRow = document.getElementById("discountRow");
  const promoRow = document.getElementById("promoRow");
  const totalSavingsRow = document.getElementById("totalSavingsRow");
  const creditRow = document.getElementById("creditRow");

  const entries = Object.entries(basket);
  const subtotal = basketSubtotalValue();
  const affiliateDiscount = discountForSubtotal(subtotal);
  const storewideDiscount = storewideDiscountForSubtotal(subtotal);
  const totalSavings = affiliateDiscount + storewideDiscount;
  const credit = storeCreditForRemaining(
    subtotal - affiliateDiscount - storewideDiscount
  );
  const totalBeforeShipping = Math.max(
    0,
    subtotal - affiliateDiscount - storewideDiscount - credit
  );

  if (cartCount) cartCount.textContent = basketCount();
  if (basketTotal) basketTotal.textContent = money(totalBeforeShipping);

  if (discountRow) {
    discountRow.innerHTML = affiliateDiscount > 0
      ? `<div class="discount-line">Affiliate code <strong>${escapeHtml(appliedCode.code)}</strong>: −${money(affiliateDiscount)}</div>`
      : "";
  }

  if (promoRow) {
    promoRow.innerHTML = storewideDiscount > 0
      ? `<div class="discount-line">Store promo <strong>${escapeHtml(appliedStorewideCode.code)}</strong>: −${money(storewideDiscount)}</div>`
      : "";
  }

  if (totalSavingsRow) {
    totalSavingsRow.innerHTML = totalSavings > 0
      ? `<div class="savings-total">You save ${money(totalSavings)}</div>`
      : "";
  }

  if (creditRow) {
    creditRow.innerHTML = credit > 0
      ? `<div class="discount-line">Store credit <strong>${escapeHtml(appliedStoreCredit.code)}</strong>: −${money(credit)}</div>`
      : "";
  }

  if (!basketLines) return;

  if (!entries.length) {
    basketLines.innerHTML = `<div class="empty">Your basket is empty.</div>`;
    return;
  }

  basketLines.innerHTML = entries.map(([id, qty]) => {
    const p = products.find(x => Number(x.id) === Number(id));
    if (!p) return "";

    const price = Number(p.pricePence || 0);

    return `
      <div class="basket-line">
        <div>
          <strong>${escapeHtml(p.name)}</strong><br>
          <span>${qty} × ${money(price)}</span>
        </div>

        <div class="basket-right">
          <strong>${money(price * Number(qty))}</strong>
          <button data-remove="${Number(p.id)}" type="button">Remove</button>
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

async function fetchProductsFrom(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`${url} did not return a product array`);
  return data;
}

async function loadProducts() {
  const productsContainer = document.getElementById("products");

  try {
    products = await fetchProductsFrom("/products.json");
  } catch (firstError) {
    console.warn("/products.json failed", firstError);

    try {
      products = await fetchProductsFrom("/api/products");
    } catch (secondError) {
      console.error("Both product endpoints failed", secondError);
      products = [];

      if (productsContainer) {
        productsContainer.innerHTML = `
          <div class="catalogue-error">
            The catalogue could not be loaded from the server. Refresh the Mini App after the latest deployment finishes.
          </div>
        `;
      }

      return;
    }
  }

  rebuildCatalogueNavigation();
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
    setStatus("");
    return;
  }

  try {
    const res = await fetch(`/api/discount-codes/${encodeURIComponent(code)}`);
    const data = await res.json();

    if (!res.ok || !data.valid) {
      appliedCode = null;
      renderBasket();
      setStatus(data.error || "That affiliate code isn't valid.", "error");
      return;
    }

    appliedCode = {
      code: data.code,
      discountType: data.discountType,
      discountValue: data.discountValue
    };

    setStatus(`${data.code} applied.`, "success");
    renderBasket();
  } catch {
    setStatus("Couldn't check that affiliate code. Try again.", "error");
  }
}

async function applyStorewideCode() {
  const input = document.getElementById("storewideCode");
  const code = input?.value.trim();

  if (!code) {
    appliedStorewideCode = null;
    renderBasket();
    setStatus("");
    return;
  }

  try {
    const res = await fetch(`/api/storewide-promo/${encodeURIComponent(code)}`);
    const data = await res.json();

    if (!res.ok || !data.valid) {
      appliedStorewideCode = null;
      renderBasket();
      setStatus(data.error || "That store promo isn't active.", "error");
      return;
    }

    appliedStorewideCode = {
      code: data.code,
      discountPercent: Number(data.discountPercent || 0)
    };

    setStatus(`${data.code} applied — extra ${data.discountPercent}% off.`, "success");
    renderBasket();
  } catch {
    setStatus("Couldn't check that store promo. Try again.", "error");
  }
}

async function applyStoreCredit() {
  const input = document.getElementById("storeCreditCode");
  const code = input?.value.trim();

  if (!code) {
    appliedStoreCredit = null;
    renderBasket();
    setStatus("");
    return;
  }

  try {
    const res = await fetch(`/api/referral-codes/${encodeURIComponent(code)}/earnings`);
    const data = await res.json();

    if (!res.ok) {
      appliedStoreCredit = null;
      renderBasket();
      setStatus(data.error || "That store credit code isn't valid.", "error");
      return;
    }

    if (!data.balancePence || Number(data.balancePence) <= 0) {
      appliedStoreCredit = null;
      renderBasket();
      setStatus("No store credit is available on that code.", "error");
      return;
    }

    appliedStoreCredit = {
      code: data.code,
      balancePence: Number(data.balancePence)
    };

    setStatus(`Store credit applied: ${money(data.balancePence)} available.`, "success");
    renderBasket();
  } catch {
    setStatus("Couldn't check that store credit code. Try again.", "error");
  }
}

async function submitOrder() {
  const customerName = document.getElementById("name")?.value.trim();
  const telegramUsername = document.getElementById("handle")?.value.trim();
  const address = document.getElementById("address")?.value.trim();

  const items = Object.entries(basket).map(([id, quantity]) => ({
    id: Number(id),
    quantity: Number(quantity)
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
        telegramId: telegramUser?.id || undefined,
        address,
        items,
        discountCode: appliedCode?.code || undefined,
        storewideCode: appliedStorewideCode?.code || undefined,
        storeCreditCode: appliedStoreCredit?.code || undefined
      })
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Something went wrong placing your order.", "error");
      return;
    }

    setStatus(
      `Order #${data.orderId} created — total ${money(data.totalPence)} including shipping.`,
      "success"
    );

    Object.keys(basket).forEach(id => delete basket[id]);
    appliedCode = null;
    appliedStorewideCode = null;
    appliedStoreCredit = null;

    const discountInput = document.getElementById("discountCode");
    const promoInput = document.getElementById("storewideCode");
    const creditInput = document.getElementById("storeCreditCode");

    if (discountInput) discountInput.value = "";
    if (promoInput) promoInput.value = "";
    if (creditInput) creditInput.value = "";

    render();
    renderPaymentPanel(data);

  } catch {
    setStatus("Couldn't reach the server. Try again.", "error");
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

  const quote = order.payment.quote?.USDT ?? "QUOTE_PENDING";

  panel.innerHTML = `
    <div class="payment-panel">
      <div class="payment-title">Send USDT (ERC-20)</div>
      <div class="payment-address">${escapeHtml(order.payment.address || "")}</div>
      <div class="payment-quote">${escapeHtml(quote)} USDT</div>
      <div class="payment-sub">${escapeHtml(order.payment.instructions || "")}</div>

      <label for="paymentTxId">Transaction hash</label>
      <input id="paymentTxId" placeholder="0x...">

      <button id="confirmPaymentBtn" class="gold-btn" type="button">
        I've paid — submit transaction
      </button>

      <div id="paymentStatus" class="status"></div>
    </div>
  `;

  document.getElementById("confirmPaymentBtn")?.addEventListener(
    "click",
    () => confirmPayment(order.orderId)
  );
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
  setPaymentStatus("Submitting transaction for confirmation…");

  try {
    const res = await fetch(`/api/orders/${orderId}/confirm-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId })
    });

    const data = await res.json();

    if (!res.ok) {
      setPaymentStatus(data.error || "Could not submit payment.", "error");
      return;
    }

    setPaymentStatus(
      "Payment submitted. We'll confirm it shortly.",
      "success"
    );
  } catch {
    setPaymentStatus("Couldn't reach the server. Try again.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.getElementById("applyDiscount")?.addEventListener("click", applyDiscountCode);
document.getElementById("applyStorewide")?.addEventListener("click", applyStorewideCode);
document.getElementById("applyStoreCredit")?.addEventListener("click", applyStoreCredit);
document.getElementById("checkoutBtn")?.addEventListener("click", submitOrder);
document.getElementById("cartJump")?.addEventListener("click", () => {
  document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" });
});

if (telegramUser?.username) {
  const handleInput = document.getElementById("handle");
  if (handleInput && !handleInput.value) {
    handleInput.value = `@${telegramUser.username}`;
  }
}

loadProducts();