const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

/* =========================================================
   KAGE SUPPS — DISPLAY-ONLY INVENTORY
   Categories: Oils / Orals / Pharma / Peps

   Regulated/prescription products in this file are DISPLAY ONLY.
   They are not connected to basket, checkout or payment.
   ========================================================= */

const categories = [
  { name: "Oils", icon: "🛢️" },
  { name: "Orals", icon: "💪" },
  { name: "Pharma", icon: "💊" },
  { name: "Peps", icon: "⚡" }
];

const sectionOrder = {
  Oils: ["Pre-Workout", "Oils", "Blends"],
  Orals: ["Orals"],
  Pharma: ["General Pharma"],
  Peps: ["Recovery", "Performance", "Weight Management", "Other"]
};

const displayProducts = [

  /* ================= PRE-WORKOUT ================= */
  {
    id: 101,
    category: "Oils",
    section: "Pre-Workout",
    name: "INJ Anadrol",
    subtitle: "30mg/ml",
    stock: 15,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 102,
    category: "Oils",
    section: "Pre-Workout",
    name: "INJ Super",
    subtitle: "20mg/ml",
    stock: 13,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 103,
    category: "Oils",
    section: "Pre-Workout",
    name: "INJ Dbol",
    subtitle: "50mg/ml",
    stock: 15,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 104,
    category: "Oils",
    section: "Pre-Workout",
    name: "Doomsday",
    subtitle: "20ml vial • 100mg/ml total (Test Base 50mg + Anadrol 30mg + Superdrol 20mg)",
    stock: 3,
    unit: "vials",
    pricePence: 7500
  },

  /* ================= OILS ================= */
  {
    id: 110,
    category: "Oils",
    section: "Oils",
    name: "Test E",
    subtitle: "300mg/ml • 10ml vial",
    stock: 16,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 111,
    category: "Oils",
    section: "Oils",
    name: "Test Cyp",
    subtitle: "200mg/ml • 10ml vial",
    stock: 16,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 112,
    category: "Oils",
    section: "Oils",
    name: "Test 400",
    subtitle: "400mg/ml • 10ml vial",
    stock: 5,
    unit: "vials",
    pricePence: 4000
  },
  {
    id: 113,
    category: "Oils",
    section: "Oils",
    name: "Sust",
    subtitle: "250mg/ml • 10ml vial",
    stock: 5,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 114,
    category: "Oils",
    section: "Oils",
    name: "Tren A",
    subtitle: "100mg/ml • 10ml vial",
    stock: 9,
    unit: "vials",
    pricePence: 3300
  },
  {
    id: 115,
    category: "Oils",
    section: "Oils",
    name: "Tren E",
    subtitle: "200mg/ml • 10ml vial",
    stock: 8,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 116,
    category: "Oils",
    section: "Oils",
    name: "Deca",
    subtitle: "300mg/ml • 10ml vial",
    stock: 4,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 117,
    category: "Oils",
    section: "Oils",
    name: "NPP",
    subtitle: "150mg/ml • 10ml vial",
    stock: 6,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 118,
    category: "Oils",
    section: "Oils",
    name: "EQ",
    subtitle: "400mg/ml • 10ml vial",
    stock: 5,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 119,
    category: "Oils",
    section: "Oils",
    name: "Mast E",
    subtitle: "250mg/ml • 10ml vial",
    stock: 10,
    unit: "vials",
    pricePence: 6000
  },
  {
    id: 120,
    category: "Oils",
    section: "Oils",
    name: "Mast P",
    subtitle: "150mg/ml • 10ml vial",
    stock: 7,
    unit: "vials",
    pricePence: 4000
  },

  /* ================= BLENDS ================= */
  {
    id: 130,
    category: "Oils",
    section: "Blends",
    name: "TTM 375",
    subtitle: "375mg/ml total • 10ml vial (Test E 150mg + Tren E 75mg + Mast E 150mg)",
    stock: 5,
    unit: "vials",
    pricePence: 4500
  },
  {
    id: 131,
    category: "Oils",
    section: "Blends",
    name: "Mass On 600",
    subtitle: "600mg/ml total • 10ml vial (Test Cyp 200mg + EQ 250mg + Deca 150mg)",
    stock: 5,
    unit: "vials",
    pricePence: 4500
  },

  /* ================= ORALS ================= */
  {
    id: 201,
    category: "Orals",
    section: "Orals",
    name: "Anavar 20mg",
    subtitle: "50 tablets",
    stock: 15,
    unit: "packs",
    pricePence: 3000
  },
  {
    id: 202,
    category: "Orals",
    section: "Orals",
    name: "Anavar 50mg",
    subtitle: "50 tablets",
    stock: 10,
    unit: "packs",
    pricePence: 5000
  },
  {
    id: 203,
    category: "Orals",
    section: "Orals",
    name: "Anadrol / Oxy 50mg",
    subtitle: "50 tablets",
    stock: 10,
    unit: "packs",
    pricePence: 3500
  },
  {
    id: 204,
    category: "Orals",
    section: "Orals",
    name: "Superdrol 20mg",
    subtitle: "50 tablets",
    stock: 10,
    unit: "packs",
    pricePence: 3000
  },
  {
    id: 205,
    category: "Orals",
    section: "Orals",
    name: "Winstrol 20mg",
    subtitle: "50 tablets",
    stock: 2,
    unit: "packs",
    pricePence: 2500
  },
  {
    id: 206,
    category: "Orals",
    section: "Orals",
    name: "Winstrol 50mg",
    subtitle: "50 tablets",
    stock: 2,
    unit: "packs",
    pricePence: 3500
  },
  {
    id: 207,
    category: "Orals",
    section: "Orals",
    name: "Turinabol 20mg",
    subtitle: "50 tablets",
    stock: 2,
    unit: "packs",
    pricePence: 3000
  },
  {
    id: 208,
    category: "Orals",
    section: "Orals",
    name: "Dbol 20mg",
    subtitle: "50 tablets",
    stock: 4,
    unit: "packs",
    pricePence: 2500
  },
  {
    id: 209,
    category: "Orals",
    section: "Orals",
    name: "Dbol 50mg",
    subtitle: "50 tablets",
    stock: 4,
    unit: "packs",
    pricePence: 3500
  },


  /* ================= PHARMA ================= */
  // Most 50-tablet items are tracked as 5 strips of 10.

  {
    id: 301,
    category: "Pharma",
    section: "General Pharma",
    name: "Cialis 10mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 302,
    category: "Pharma",
    section: "General Pharma",
    name: "Rosuvastatin",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 303,
    category: "Pharma",
    section: "General Pharma",
    name: "Nebivolol 5mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 304,
    category: "Pharma",
    section: "General Pharma",
    name: "Telmisartan 40mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 305,
    category: "Pharma",
    section: "General Pharma",
    name: "T3 25mcg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 306,
    category: "Pharma",
    section: "General Pharma",
    name: "T4 100mcg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 307,
    category: "Pharma",
    section: "General Pharma",
    name: "Clenbuterol 40mcg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 308,
    category: "Pharma",
    section: "General Pharma",
    name: "Orlistat 120mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 309,
    category: "Pharma",
    section: "General Pharma",
    name: "Yohimbine 10mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 310,
    category: "Pharma",
    section: "General Pharma",
    name: "Empagliflozin 25mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 311,
    category: "Pharma",
    section: "General Pharma",
    name: "Metformin 500mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 312,
    category: "Pharma",
    section: "General Pharma",
    name: "Imeglimin 500mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 313,
    category: "Pharma",
    section: "General Pharma",
    name: "Dutasteride 0.5mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 314,
    category: "Pharma",
    section: "General Pharma",
    name: "Finasteride 1mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 315,
    category: "Pharma",
    section: "General Pharma",
    name: "Modafinil 200mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 316,
    category: "Pharma",
    section: "General Pharma",
    name: "Armodafinil 150mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 317,
    category: "Pharma",
    section: "General Pharma",
    name: "Pregabalin 150mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 318,
    category: "Pharma",
    section: "General Pharma",
    name: "Lemborexant 5mg",
    subtitle: "56 tablets total",
    stock: 56,
    unit: "tablets"
  },
  {
    id: 319,
    category: "Pharma",
    section: "General Pharma",
    name: "Lemborexant 10mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 320,
    category: "Pharma",
    section: "General Pharma",
    name: "Melatonin 60mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 321,
    category: "Pharma",
    section: "General Pharma",
    name: "Ursodec",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 322,
    category: "Pharma",
    section: "General Pharma",
    name: "Eperisone",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 323,
    category: "Pharma",
    section: "General Pharma",
    name: "Zopiclone 10mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 324,
    category: "Pharma",
    section: "General Pharma",
    name: "Mirabegron 50mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 325,
    category: "Pharma",
    section: "General Pharma",
    name: "Tretinoin 0.1%",
    subtitle: "5 units total",
    stock: 5,
    unit: "units"
  },
  {
    id: 326,
    category: "Pharma",
    section: "General Pharma",
    name: "Accutane 10mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 327,
    category: "Pharma",
    section: "General Pharma",
    name: "Cabergoline 0.5mg",
    subtitle: "10 tablets per strip",
    stock: 2,
    unit: "strips"
  },
  {
    id: 328,
    category: "Pharma",
    section: "General Pharma",
    name: "Doxycycline 100mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 329,
    category: "Pharma",
    section: "General Pharma",
    name: "Estradiol Valerate",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 330,
    category: "Pharma",
    section: "General Pharma",
    name: "Arimidex 1mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 331,
    category: "Pharma",
    section: "General Pharma",
    name: "Aromasin 25mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 332,
    category: "Pharma",
    section: "General Pharma",
    name: "Clomid 50mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  },
  {
    id: 333,
    category: "Pharma",
    section: "General Pharma",
    name: "Tamoxifen 25mg",
    subtitle: "10 tablets per strip",
    stock: 5,
    unit: "strips"
  }
];

/* =========================================================
   BASKET-READY PRODUCTS ARRAY

   Keep the current catalogue above as display-only.
   Later, when you replace/add lawful products that should be
   purchasable, add them to THIS array.

   Example format:
   {
     id: 9001,
     category: "Peps",
     section: "Other",
     name: "Example Product",
     subtitle: "Example size",
     stock: 10,
     unit: "units",
     pricePence: 1999
   }

   Anything added here will receive + / - basket controls.

   Products now live in /public/products.json so the server can
   validate prices/stock against the exact same list the shop
   displays. Add lawful products there.
   ========================================================= */
let products = [];

const basket = {};
let currentCategory = categories[0].name;
let appliedCode = null; // { code, discountType, discountValue } once validated by the server

const money = p => `£${(p / 100).toFixed(2)}`;

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
      ${c.icon} ${c.name}
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

function displayCard(p) {
  return `
    <div class="product">
      <div>
        <h3>${p.name}</h3>
        ${p.subtitle ? `<div class="sub">${p.subtitle}</div>` : ""}
        ${stockBadge(p.stock, p.unit)}
      </div>

      <div class="price">
        ${p.pricePence ? money(p.pricePence) : ""}
      </div>
    </div>
  `;
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
    const displayItems = displayProducts.filter(
      p => p.category === currentCategory && p.section === section
    );

    const shopItems = products.filter(
      p => p.category === currentCategory && p.section === section
    );

    html += `<div class="section-title">${section}</div>`;

    if (!displayItems.length && !shopItems.length) {
      html += `<div class="empty">No products added yet.</div>`;
    } else {
      html += displayItems.map(displayCard).join("");
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
      } else {
        basket[id] = next;
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

function basketTotalValue() {
  const subtotal = basketSubtotalValue();
  return subtotal - discountForSubtotal(subtotal);
}

function renderBasket() {
  const basketLines = document.getElementById("basketLines");
  const basketTotal = document.getElementById("basketTotal");
  const cartCount = document.getElementById("cartCount");
  const discountRow = document.getElementById("discountRow");
  const entries = Object.entries(basket);
  const subtotal = basketSubtotalValue();
  const discount = discountForSubtotal(subtotal);

  if (cartCount) {
    cartCount.textContent = basketCount();
  }

  if (basketTotal) {
    basketTotal.textContent = money(subtotal - discount);
  }

  if (discountRow) {
    discountRow.innerHTML = discount > 0
      ? `<div class="discount-line">Code <strong>${appliedCode.code}</strong> applied: −${money(discount)}</div>`
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
      delete basket[Number(btn.dataset.remove)];
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
    const res = await fetch(`/api/discount-codes/${encodeURIComponent(code)}`);
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

async function submitOrder() {
  const customerName = document.getElementById("name")?.value.trim();
  const telegramUsername = document.getElementById("handle")?.value.trim();
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
        address,
        items,
        discountCode: appliedCode?.code || undefined
      })
    });

    const data = await res.json();

    if (!res.ok) {
      setStatus(data.error || "Something went wrong placing your order.", "error");
      return;
    }

    setStatus(`Order #${data.orderId} created — total ${money(data.totalPence)}. ${data.payment?.instructions || ""}`, "success");
    Object.keys(basket).forEach(id => delete basket[id]);
    appliedCode = null;
    if (document.getElementById("discountCode")) document.getElementById("discountCode").value = "";
    render();
  } catch (err) {
    setStatus("Couldn't reach the server, try again.", "error");
  } finally {
    if (checkoutBtn) checkoutBtn.disabled = false;
  }
}

document.getElementById("applyDiscount")?.addEventListener("click", applyDiscountCode);
document.getElementById("checkoutBtn")?.addEventListener("click", submitOrder);
document.getElementById("cartJump")?.addEventListener("click", () => {
  document.getElementById("checkout")?.scrollIntoView({ behavior: "smooth" });
});

loadProducts();