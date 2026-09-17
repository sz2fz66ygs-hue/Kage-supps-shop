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
    name: "INJ Anadrol 30mg",
    stock: 15,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 102,
    category: "Oils",
    section: "Pre-Workout",
    name: "INJ Super",
    stock: 13,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 103,
    category: "Oils",
    section: "Pre-Workout",
    name: "INJ Dbol",
    stock: 15,
    unit: "vials",
    pricePence: 2500
  },
  {
    id: 104,
    category: "Oils",
    section: "Pre-Workout",
    name: "Doomsday",
    subtitle: "20ml vial",
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
    stock: 16,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 111,
    category: "Oils",
    section: "Oils",
    name: "Test Cyp",
    stock: 16,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 112,
    category: "Oils",
    section: "Oils",
    name: "Test 400",
    stock: 5,
    unit: "vials",
    pricePence: 4000
  },
  {
    id: 113,
    category: "Oils",
    section: "Oils",
    name: "Sust",
    stock: 5,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 114,
    category: "Oils",
    section: "Oils",
    name: "Tren A",
    stock: 9,
    unit: "vials",
    pricePence: 3300
  },
  {
    id: 115,
    category: "Oils",
    section: "Oils",
    name: "Tren E",
    stock: 8,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 116,
    category: "Oils",
    section: "Oils",
    name: "Deca",
    stock: 4,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 117,
    category: "Oils",
    section: "Oils",
    name: "NPP",
    stock: 6,
    unit: "vials",
    pricePence: 3200
  },
  {
    id: 118,
    category: "Oils",
    section: "Oils",
    name: "EQ",
    stock: 5,
    unit: "vials",
    pricePence: 3500
  },
  {
    id: 119,
    category: "Oils",
    section: "Oils",
    name: "Mast E",
    stock: 10,
    unit: "vials",
    pricePence: 6000
  },
  {
    id: 120,
    category: "Oils",
    section: "Oils",
    name: "Mast P",
    stock: 7,
    unit: "vials",
    pricePence: 4000
  },

  /* ================= BLENDS ================= */
  {
    id: 130,
    category: "Oils",
    section: "Blends",
    name: "TTM",
    stock: 5,
    unit: "vials",
    pricePence: 4500
  },
  {
    id: 131,
    category: "Oils",
    section: "Blends",
    name: "Mass On",
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

/* Keep checkout products separate.
   Regulated/prescription items above are display-only. */
const products = [];

const basket = {};
let currentCategory = categories[0].name;

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

function renderProducts() {
  let html = "";

  (sectionOrder[currentCategory] || []).forEach(section => {
    const displayItems = displayProducts.filter(
      p => p.category === currentCategory && p.section === section
    );

    html += `<div class="section-title">${section}</div>`;

    if (!displayItems.length) {
      html += `<div class="empty">No products added yet.</div>`;
    } else {
      html += displayItems.map(displayCard).join("");
    }
  });

  document.getElementById("products").innerHTML = html;
}

function renderBasket() {
  const basketLines = document.getElementById("basketLines");
  const basketTotal = document.getElementById("basketTotal");
  const cartCount = document.getElementById("cartCount");

  if (basketLines) basketLines.textContent = "Your basket is empty.";
  if (basketTotal) basketTotal.textContent = "£0.00";
  if (cartCount) cartCount.textContent = "0";
}

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
}

render();