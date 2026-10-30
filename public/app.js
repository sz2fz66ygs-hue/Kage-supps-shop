const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const telegramUser =
  tg?.initDataUnsafe?.user ||
  null;


/* =========================================================
   CATALOGUE SETTINGS
   ========================================================= */

const preferredCategoryOrder = [
  "Oils",
  "Oral Anabolics",
  "Orals",
  "Pharma",
  "Research Compounds",
  "Peps"
];

const categoryIcons = {
  Oils: "🛢️",
  "Oral Anabolics": "💪",
  Orals: "💪",
  Pharma: "💊",
  "Research Compounds": "🧪",
  Peps: "⚡"
};

const categoryLabels = {
  Orals: "Oral Anabolics"
};

const preferredSectionOrder = {
  Oils: [
    "Oils",
    "Blends",
    "Injectable PWOs"
  ],

  "Oral Anabolics": [
    "Oral Anabolics"
  ],
  Orals: [
    "Oral Anabolics"
  ],
  "Research Compounds": [
    "Metabolic",
    "Cognitive"
  ],

  Pharma: [
    "Cardiovascular",
    "Metabolic",
    "Hormones & Related",
    "Sleep",
    "Neurology & Wakefulness",
    "Sexual Health",
    "Hair & Skin",
    "Antibiotics",
    "Pain",
    "Insulin",
    "Other Pharma"
  ],

  Peps: [
    "Recovery",
    "Weight Management",
    "Other"
  ]
};


/* =========================================================
   SHOP STATE
   ========================================================= */

let products = [];
let categories = [];
let sectionOrder = {};

const basket = {};
document.addEventListener("click", event => {
  const button = event.target.closest("[data-restock]");
  if (!button) return;
  watchRestock(Number(button.dataset.restock));
});
document.addEventListener("input", event => {
  if (event.target?.id === "shopSearch") render();
});
document.addEventListener("click", event => {
  const star = event.target.closest("[data-fav]");
  if (!star) return;
  const id = String(star.dataset.fav);
  const favs = new Set(JSON.parse(localStorage.getItem("kage-favs") || "[]"));
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  localStorage.setItem("kage-favs", JSON.stringify([...favs]));
  render();
});

function nextDispatchText() {
  const now = new Date(new Date().toLocaleString("en-GB", { timeZone: "Europe/London" }));
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  const slots = [
    { day: 1, cutoff: 12 * 60, label: "Monday 12pm" },
    { day: 3, cutoff: 12 * 60, label: "Wednesday 12pm" },
    { day: 5, cutoff: 10 * 60, label: "Friday 10am" }
  ];
  for (let offset = 0; offset < 8; offset++) {
    const check = (day + offset) % 7;
    const slot = slots.find(item => item.day === check);
    if (!slot) continue;
    if (offset === 0 && mins >= slot.cutoff) continue;
    return offset === 0 ? `Posts ${slot.label} if you pay before the cutoff.` : `Next post is ${slot.label}.`;
  }
  return "Posts Monday, Wednesday and Friday.";
}

try {
  Object.assign(basket, JSON.parse(localStorage.getItem("kage-basket-v1") || "{}"));
} catch {}
function saveBasket() {
  try { localStorage.setItem("kage-basket-v1", JSON.stringify(basket)); } catch {}
}

let currentCategory = null;

let appliedCode = null;
let appliedStorewideCode = null;
let appliedStoreCredit = null;
let livePromotions = [];

let paymentCountdownTimer = null;


/* =========================================================
   BASIC HELPERS
   ========================================================= */

const money = p =>
  `£${(
    Number(
      p ||
      0
    ) /
    100
  ).toFixed(2)}`;


function escapeHtml(value) {
  return String(
    value ??
    ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


/* =========================================================
   CATALOGUE NAVIGATION
   ========================================================= */

function rebuildCatalogueNavigation() {
  products.forEach(product => {
    const name = String(product.name || "").toLowerCase();
    if (name.includes("atx") || name.includes("bam") || name.includes("slu") || name.includes("sana") || name.includes("dihexa") || name.includes("noopept")) {
      product.category = "Research Compounds";
      product.section = "Research Compounds";
    }
  });

  const foundCategories = [
    ...new Set(
      products.map(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ||
          "Other"
      )
    )
  ];

  const ordered = [
    ...preferredCategoryOrder.filter(
      name =>
        foundCategories.includes(
          name
        )
    ),

    ...foundCategories.filter(
      name =>
        !preferredCategoryOrder.includes(
          name
        )
    )
  ];

  categories =
    ordered.map(
      name => ({
        name,
        label: categoryLabels[name] || name,

        icon:
          categoryIcons[name] ||
          "•"
      })
    );

  sectionOrder = {};

  for (
    const category
    of ordered
  ) {
    const foundSections = [
      ...new Set(
        products
          .filter(
            p =>
              String(
                p.category ||
                "Other"
              ).trim() ===
              category
          )
          .map(
            p =>
              shopSection(p)
          )
      )
    ];

    const preferred =
      preferredSectionOrder[category] ||
      [];

    sectionOrder[category] = [
      ...preferred.filter(
        name =>
          foundSections.includes(
            name
          )
      ),

      ...foundSections.filter(
        name =>
          !preferred.includes(
            name
          )
      )
    ];
  }

  if (
    !currentCategory ||
    !ordered.includes(
      currentCategory
    )
  ) {
    currentCategory =
      ordered[0] ||
      null;
  }
}


/* =========================================================
   CART EVENTS
   ========================================================= */

function postCartEvent(
  productId,
  action
) {
  fetch(
    "/api/cart-events",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          productId,
          action
        })
    }
  )
    .catch(
      () => {}
    );
}


/* =========================================================
   STOCK BADGE
   ========================================================= */

function stockBadge(stock, unit = "items", category = "") {
  const n = Number(stock);
  if (!Number.isFinite(n)) return "";
  if (n <= 0) return `<span class="stock out">Out of stock</span>`;
  if (n <= 5) return `<span class="stock lowstock">Low stock · ${n} left</span>`;
  return `<span class="stock good">In stock</span>`;
}


/* =========================================================
   CATEGORY TABS
   ========================================================= */

function renderTabs() {
  const tabs =
    document.getElementById(
      "tabs"
    );

  if (
    !tabs
  ) {
    return;
  }

  tabs.innerHTML =
    categories
      .map(
        c => `
          <button
            class="tab ${
              c.name === currentCategory
                ? "active"
                : ""
            }"
            data-category="${escapeHtml(c.name)}"
            type="button"
          >
            ${c.icon} ${escapeHtml(c.label || c.name)}
          </button>
        `
      )
      .join("") +
    `<button class="tab ${currentCategory === "Favourites" ? "active" : ""}" data-category="Favourites" type="button">★ Favourites</button>`;

  document
    .querySelectorAll(
      "[data-category]"
    )
    .forEach(
      btn => {
        btn.addEventListener(
          "click",
          () => {
            currentCategory =
              btn.dataset.category;

            render();

            window.scrollTo({
              top:
                0,

              behavior:
                "smooth"
            });
          }
        );
      }
    );
}


/* =========================================================
   PRODUCT CARD
   ========================================================= */


function vialSize(product) {
  if (String(product.category || "").trim() !== "Oils") return "";
  const name = String(product.name || "").toLowerCase();
  if (name.includes("doomsday")) return "20 ml vial";
  return "10 ml vial";
}

function blendLines(product) {
  const name = String(product.name || "").toLowerCase();
  if (name.includes("mass on")) return ["Test C 200mg/ml", "EQ 250mg/ml", "Deca 150mg/ml"];
  if (name.includes("ttm")) return ["Test E 150mg/ml", "Tren E 75mg/ml", "Mast E 150mg/ml"];
  if (name.includes("doomsday")) return ["Test Base 50mg/ml", "Anadrol 30mg/ml", "Superdrol 20mg/ml"];
  return [];
}


function subtitleLines(product) {
  const raw = String(product.subtitle || "").trim();
  if (!raw) return [];
  const parts = raw.split(/\s*[•·|]\s*/).map(part => part.trim()).filter(Boolean);
  const lines = [];
  for (const part of parts) {
    const pack = part.match(/^(\d+\s+(?:capsules?|vials?|tabs?|tablets?|strips?|pens?|pouches?|ampoules?|ampules?|ml))\s+per\s+\w+/i);
    if (pack) {
      lines.push(pack[1].trim());
      continue;
    }
    const dose = part.match(/^(.+?)\s+per\s+(?:capsule|vial|ml|tab|tablet|strip|pen|pouch|ampoule|ampule)\b/i);
    lines.push((dose ? dose[1] : part).trim());
  }
  return [...new Set(lines.filter(Boolean))];
}

function shopCard(p) {
  const id =
    Number(
      p.id
    );

  const qty =
    basket[id] ||
    0;

  const shownPricePence =
    Number(
      p.displayPricePence ??
      p.pricePence
    );

  const truePricePence =
    Number(
      p.pricePence
    );

  const stock =
    Number(
      p.stock ??
      0
    );

  const canPurchase =
    p.purchasable !==
      false &&
    Number.isFinite(
      truePricePence
    ) &&
    truePricePence >=
      0;

  const priceText =
    Number.isFinite(
      shownPricePence
    )
      ? money(
          shownPricePence
        )
      : "";

  return `
    <div class="product">

      <div class="product-body">
        <div class="product-head">
          <h3>${escapeHtml(p.name)}</h3>
        </div>

        ${
          blendLines(p).length
            ? blendLines(p).map(line => `<div class="sub compound-line">${escapeHtml(line)}</div>`).join("")
            : subtitleLines(p).map(line => `<div class="sub compound-line">${escapeHtml(line)}</div>`).join("")
        }

        ${Number(stock) <= 0 ? `<button type="button" class="restock-link" data-restock="${id}">Tell me when it's back</button>` : ""}
        <div class="stock-corner">${stockBadge(p.stock, p.unit, p.category)}</div>
      </div>

      <div class="product-buy">

        <div class="price">
          ${priceText}
        </div>

        ${
          canPurchase
            ? `
              <div class="qty">

                <button
                  data-id="${id}"
                  data-d="-1"
                  type="button"
                  ${
                    qty ===
                    0
                      ? "disabled"
                      : ""
                  }
                >
                  −
                </button>

                <span>
                  ${qty}
                </span>

                <button
                  data-id="${id}"
                  data-d="1"
                  type="button"
                  ${
                    qty >=
                    Math.min(stock, Number(p.maxPerOrder || 0) || stock)
                      ? "disabled"
                      : ""
                  }
                >
                  +
                </button>

              </div>
            `
            : ""
        }

        <button type="button" data-fav="${id}" class="star-btn" aria-label="Save">${(JSON.parse(localStorage.getItem("kage-favs") || "[]")).includes(String(id)) ? "★" : "☆"}</button>

      </div>

    </div>
  `;
}


/* =========================================================
   PRODUCTS
   ========================================================= */

function productMatchesSearch(product) {
  const query = String(document.getElementById("shopSearch")?.value || "").trim().toLowerCase();
  if (!query) return true;
  return `${product.name} ${product.subtitle || ""} ${product.section || ""}`.toLowerCase().includes(query);
}



function shopSection(product) {
  const category = String(product.category || "").trim();
  const name = String(product.name || "").toLowerCase();
  if (category === "Oils") {
    if (name.includes("mass on") || name.includes("ttm")) return "Blends";
    if (
      name.includes("doomsday") ||
      name.startsWith("inj ") ||
      name.includes("anadrol") ||
      name.includes("superdrol") ||
      name.includes("dbol") ||
      name.includes("dianabol") ||
      String(product.section || "").toLowerCase().includes("pwo") ||
      String(product.section || "").toLowerCase().includes("pre-workout")
    ) return "Injectable PWOs";
    return "Oils";
  }
  if (category === "Orals" || category === "Oral Anabolics") {
    return "Oral Anabolics";
  }
  if (category === "Research Compounds") {
    if (name.includes("dihexa") || name.includes("noopept")) return "Cognitive";
    return "Metabolic";
  }
  if (category === "Peps") return String(product.section || "Other").trim() || "Other";
  return String(product.section || "Other").trim() || "Other";
}

function compoundRank(name) {
  const n = String(name || "").toLowerCase();
  const order = [
    ["test e", 10], ["testosterone cypionate", 11], ["test cyp", 11], ["test c)", 11], ["test 400", 12], ["sust", 13],
    ["tren a", 20], ["tren e", 21], ["eq", 30], ["deca", 40], ["npp", 41],
    ["mast e", 50], ["mast p", 51], ["mass on", 55], ["ttm", 56],
    ["doomsday", 57], ["inj anadrol", 58], ["inj dbol", 59], ["inj superdrol", 60],
    ["anavar", 70], ["anadrol", 71], ["dbol", 72], ["superdrol", 73],
    ["turinabol", 74], ["winstrol", 75], ["proviron", 76],
    ["atx", 80], ["bam", 81], ["dihexa", 82], ["noopept", 83], ["sana", 84], ["slu", 85],
    ["nebivolol", 100], ["rosuvastatin", 101], ["telmisartan", 102], ["eplerenone", 103], ["valsartan", 104],
    ["empagliflozin", 110], ["imeglimin", 111], ["metformin", 112], ["orlistat", 113], ["pioglitazone", 114], ["ezetimibe", 115], ["yohimbine", 116],
    ["arimidex", 120], ["aromasin", 121], ["cabergoline", 122], ["clen", 123], ["clomid", 124], ["estradiol", 125], ["t3", 126], ["t4", 127], ["tamoxifen", 128], ["raloxifene", 129], ["progesterone", 130],
    ["lemborexant", 140], ["melatonin", 141], ["zopiclone", 142], ["eszopiclone", 143],
    ["armodafinil", 150], ["modafinil", 151], ["pregabalin", 152], ["memantine", 153],
    ["cialis", 160], ["viagra", 161],
    ["accutane", 170], ["dutasteride", 171], ["finasteride", 172], ["tretinoin", 173], ["iso cream", 174], ["estriol", 175], ["minoxidil", 176], ["ketoconazole", 177],
    ["amoxicillin", 180], ["azithromycin", 181], ["doxycycline", 182],
    ["diclofenac", 190], ["naproxen", 191], ["meloxicam", 192], ["tapentadol", 193],
    ["tresiba", 200], ["lispro", 201], ["novorapid", 202],
    ["eperisone", 210], ["mirabegron", 211], ["ursodec", 212], ["trazodone", 213], ["amitriptyline", 214], ["mebeverine", 215], ["glutathione", 216], ["ketotifen", 217], ["baclofen", 218], ["clonidine", 219],
    ["bpc", 230], ["ghk", 231], ["cagri", 232], ["retatrutide", 233], ["mt2", 234], ["bac water", 235]
  ];
  for (const [key, rank] of order) if (n.includes(key)) return rank;
  return 900;
}

function researchRank(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("atx") && n.includes("bam")) return 10;
  if (n.includes("slu") && n.includes("bam")) return 11;
  if (n.includes("atx")) return 20;
  if (n.includes("bam")) return 21;
  if (n.includes("slu")) return 30;
  if (n.includes("sana")) return 31;
  if (n.includes("dihexa")) return 40;
  if (n.includes("noopept")) return 41;
  return 90;
}

function compareProducts(a, b) {
  if (String(a.category || "") === "Research Compounds" && String(b.category || "") === "Research Compounds") {
    const rank = researchRank(a.name) - researchRank(b.name);
    if (rank) return rank;
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true });
  }
  const rank = compoundRank(a.name) - compoundRank(b.name);
  if (rank) return rank;
  return String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true });
}

function renderProducts() {
  const container =
    document.getElementById(
      "products"
    );

  if (
    !container
  ) {
    return;
  }

  const visibleProducts = products.filter(product => product.purchasable !== false && productMatchesSearch(product));

  if (
    !products.length
  ) {
    container.innerHTML = `
      <div class="catalogue-error">
        No products could be loaded.
        Please refresh the shop.
      </div>
    `;

    return;
  }

  if (currentCategory === "Favourites") {
    const favs = JSON.parse(localStorage.getItem("kage-favs") || "[]").map(Number);
    const saved = visibleProducts.filter(product => favs.includes(Number(product.id)));
    container.innerHTML = saved.length
      ? `<div class="section-title">Favourites</div>${saved.map(shopCard).join("")}`
      : `<div class="catalogue-error">Tap the star on a product to save it here.</div>`;
    return;
  }

  if (
    !currentCategory
  ) {
    container.innerHTML =
      visibleProducts
        .map(
          shopCard
        )
        .join("");

    return;
  }

  const sections =
    sectionOrder[currentCategory] ||
    [];

  let html =
    "";

  for (
    const section
    of sections
  ) {
    const shopItems =
      visibleProducts.filter(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ===
            currentCategory &&

          shopSection(p) ===
            section
      ).sort(compareProducts);

    if (
      !shopItems.length
    ) {
      continue;
    }

    html += `
      <div class="section-title">
        ${escapeHtml(section)}
      </div>
    `;

    html +=
      shopItems
        .map(
          shopCard
        )
        .join("");
  }

  if (
    !html
  ) {
    const fallback =
      visibleProducts.filter(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ===
          currentCategory
      ).sort(compareProducts);

    html =
      fallback.length
        ? `<div class="section-title">${escapeHtml(currentCategory)}</div>${fallback.map(shopCard).join("")}`
        : "";
  }

  container.innerHTML =
    html;

  document
    .querySelectorAll(
      "[data-d]"
    )
    .forEach(
      btn => {
        btn.addEventListener(
          "click",
          () => {
            const id =
              Number(
                btn.dataset.id
              );

            const delta =
              Number(
                btn.dataset.d
              );

            const product =
              products.find(
                p =>
                  Number(
                    p.id
                  ) ===
                  id
              );

            if (
              !product
            ) {
              return;
            }

            const stock =
              Math.max(
                0,
                Number(
                  product.stock ||
                  0
                )
              );

            const current =
              basket[id] ||
              0;

            const maxPerOrder = Number(product.maxPerOrder || 0);
            const cap = maxPerOrder > 0 ? Math.min(stock, maxPerOrder) : stock;
            const next =
              Math.max(
                0,

                Math.min(
                  cap,
                  current +
                    delta
                )
              );

            if (
              next ===
              0
            ) {
              delete basket[id];

              if (
                current >
                0
              ) {
                postCartEvent(
                  id,
                  "remove"
                );
              }

            } else {
              basket[id] =
                next;

              if (
                current ===
                0
              ) {
                postCartEvent(
                  id,
                  "add"
                );
              }
            }

            tg
              ?.HapticFeedback
              ?.selectionChanged();

            saveBasket();
            render();
          }
        );
      }
    );
}


/* =========================================================
   BASKET HELPERS
   ========================================================= */


function calculatePromotionDiscount(lineItems, promotions) {
  const active = (promotions || []).filter(promo => promo.active !== false);
  const applied = [];
  let promotionDiscountPence = 0;

  for (const promo of active) {
    const eligibleIds = new Set((promo.productIds || []).map(Number));
    const units = [];

    for (const item of lineItems) {
      if (!eligibleIds.has(Number(item.id))) continue;
      const qty = Number(item.quantity || 0);
      const price = Number(item.pricePence || 0);
      for (let i = 0; i < qty; i += 1) {
        units.push({ id: Number(item.id), pricePence: price });
      }
    }

    if (!units.length) continue;

    const maxUnits = Number(promo.maxUnits || 0);
    if (maxUnits > 0 && units.length > maxUnits) units.length = maxUnits;

    const required = Math.max(1, Number(promo.requiredQuantity || 1));
    let discount = 0;

    if (promo.type === "fixed_bundle") {
      const bundles = Math.floor(units.length / required);
      if (!bundles) continue;
      const bundleUnits = units.slice().sort((a, b) => b.pricePence - a.pricePence).slice(0, bundles * required);
      const normal = bundleUnits.reduce((sum, unit) => sum + unit.pricePence, 0);
      discount = Math.max(0, normal - bundles * Number(promo.bundlePricePence || 0));
    } else {
      const qualifying = Math.floor(units.length / required) * required;
      if (!qualifying) continue;
      const chosen = units.slice(0, qualifying);
      if (promo.type === "fixed_amount") {
        const perUnit = Number(promo.discountPence || 0);
        discount = chosen.reduce((sum, unit) => sum + Math.min(unit.pricePence, perUnit), 0);
      } else {
        const percent = Number(promo.discountPercent || 0);
        discount = chosen.reduce((sum, unit) => sum + Math.round(unit.pricePence * (percent / 100)), 0);
      }
    }

    if (discount > 0) {
      promotionDiscountPence += discount;
      applied.push({
        id: promo.id,
        name: promo.name,
        discountPence: discount
      });
    }
  }

  return { promotionDiscountPence, applied };
}

async function loadPromotions() {
  try {
    const res = await fetch("/api/promotions", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    livePromotions = Array.isArray(data) ? data : [];
    renderBasket();
  } catch {}
}

function basketCount() {
  return Object
    .values(
      basket
    )
    .reduce(
      (
        sum,
        qty
      ) =>
        sum +
        Number(
          qty ||
          0
        ),

      0
    );
}


function basketSubtotalValue() {
  return Object
    .entries(
      basket
    )
    .reduce(
      (
        sum,
        [
          id,
          qty
        ]
      ) => {
        const product =
          products.find(
            p =>
              Number(
                p.id
              ) ===
              Number(
                id
              )
          );

        const price =
          Number(
            product?.pricePence
          );

        return (
          sum +
          (
            product &&
            Number.isFinite(
              price
            )
              ? price *
                Number(
                  qty
                )
              : 0
          )
        );
      },

      0
    );
}


/* =========================================================
   DISCOUNT CALCULATIONS
   ========================================================= */

function discountForSubtotal(
  subtotalPence
) {
  if (
    !appliedCode
  ) {
    return 0;
  }

  const raw =
    appliedCode.discountType ===
      "percent"
      ? Math.round(
          subtotalPence *
          (
            Number(
              appliedCode.discountValue
            ) /
            100
          )
        )
      : Number(
          appliedCode.discountValue ||
          0
        );

  return Math.min(
    Math.max(
      0,
      raw
    ),
    subtotalPence
  );
}


function storewideDiscountForSubtotal(
  subtotalPence
) {
  if (
    !appliedStorewideCode
  ) {
    return 0;
  }

  const raw =
    Math.round(
      subtotalPence *
      (
        Number(
          appliedStorewideCode.discountPercent ||
          0
        ) /
        100
      )
    );

  return Math.min(
    Math.max(
      0,
      raw
    ),
    subtotalPence
  );
}


let personalCreditPence = 0;

async function loadPersonalCredit() {
  const id = telegramUser?.id;
  if (!id) return;
  try {
    const res = await fetch(`/api/store-credit?initData=${encodeURIComponent(tg?.initData || "")}`);
    const data = await res.json();
    personalCreditPence = Number(data.balancePence || 0);
    renderBasket();
  } catch {}
}

function storeCreditForRemaining(
  remainingPence
) {
  if (
    !appliedStoreCredit
  ) {
    return 0;
  }

  return Math.min(
    Math.max(
      0,

      Number(
        appliedStoreCredit.balancePence ||
        0
      )
    ),

    Math.max(
      0,
      remainingPence
    )
  );
}


/* =========================================================
   BASKET RENDER
   ========================================================= */

function reportBasket() {
  const items = Object.entries(basket).map(([id, quantity]) => ({
    id: Number(id),
    name: products.find(product => Number(product.id) === Number(id))?.name || "",
    quantity
  })).filter(item => item.quantity > 0);
  fetch("/api/basket-live", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      telegramId: telegramUser?.id || "",
      username: telegramUser?.username || "",
      name: telegramUser?.first_name || "",
      items
    })
  }).catch(() => {});
}

function ensureReferField() {
  if (document.getElementById("referHandle")) return;
  const address = document.getElementById("address");
  if (!address) return;
  const wrap = document.createElement("div");
  wrap.style.margin = "12px 0";
  wrap.innerHTML = `
    <label for="referHandle" style="display:block;font-weight:700;margin-bottom:6px;">Friend's Telegram handle</label>
    <input id="referHandle" placeholder="@theirhandle" style="width:100%;padding:12px;border:1px solid #e6dcc8;border-radius:12px;font-size:16px;" />
    <div style="font-size:13px;color:#6f6a62;margin-top:6px;">Only for your first order. They get £10 store credit when you pay.</div>
  `;
  address.parentNode.insertBefore(wrap, address.nextSibling);
}

function renderBasket() {
  const notice = document.querySelector(".shop-notice");
  if (notice && !notice.dataset.dispatch) {
    notice.dataset.dispatch = "1";
    notice.insertAdjacentHTML("beforeend", `<br>${nextDispatchText()}`);
  }

  ensureReferField();
  reportBasket();
  const basketLines =
    document.getElementById(
      "basketLines"
    );

  const basketTotal =
    document.getElementById(
      "basketTotal"
    );

  const cartCount =
    document.getElementById(
      "cartCount"
    );

  const discountRow =
    document.getElementById(
      "discountRow"
    );

  const promoRow =
    document.getElementById(
      "promoRow"
    );

  const totalSavingsRow =
    document.getElementById(
      "totalSavingsRow"
    );

  const creditRow =
    document.getElementById(
      "creditRow"
    );

  const entries =
    Object.entries(
      basket
    );

  const subtotal =
    basketSubtotalValue();

  const lineItems =
    Object.entries(basket).map(([id, qty]) => {
      const product = products.find(p => Number(p.id) === Number(id));
      return {
        id: Number(id),
        quantity: Number(qty),
        pricePence: Number(product?.pricePence || 0)
      };
    });

  const promosForBasket =
    livePromotions.filter(promo => {
      if (appliedCode && promo.stackWithAffiliate === false) return false;
      return true;
    });

  const promotionResult =
    calculatePromotionDiscount(
      lineItems,
      promosForBasket
    );

  const promotionDiscount =
    promotionResult.promotionDiscountPence;

  const afterPromotion =
    Math.max(0, subtotal - promotionDiscount);

  const affiliateDiscount =
    discountForSubtotal(
      afterPromotion
    );

  const storewideDiscount =
    storewideDiscountForSubtotal(
      afterPromotion
    );

  const totalSavings =
    promotionDiscount +
    affiliateDiscount +
    storewideDiscount;

  const afterCodes = Math.max(0, afterPromotion - affiliateDiscount - storewideDiscount);
  const codeCredit = storeCreditForRemaining(afterCodes);
  const personalCredit = Math.min(Math.max(0, personalCreditPence), Math.max(0, afterCodes - codeCredit));
  const credit = codeCredit + personalCredit;

  const totalBeforeShipping =
    Math.max(
      0,
      afterPromotion -
      affiliateDiscount -
      storewideDiscount -
      credit
    );

  if (
    cartCount
  ) {
    cartCount.textContent =
      basketCount();
    const pill = document.getElementById("cartJump");
    if (pill) pill.classList.toggle("has-items", basketCount() > 0);
  }
  const minimum = 5000;
  const showMin = basketCount() > 0 && totalBeforeShipping < minimum;
  const percent = Math.min(100, Math.round((totalBeforeShipping / minimum) * 100));
  const short = Math.max(0, minimum - totalBeforeShipping);

  const minProgress = document.getElementById("minProgress");
  if (minProgress) minProgress.hidden = true;

  const minBar = document.getElementById("minBar");
  const minBarLabel = document.getElementById("minBarLabel");
  const minBarFill = document.getElementById("minBarFill");
  if (minBar) {
    minBar.hidden = !showMin;
    if (showMin) {
      if (minBarLabel) minBarLabel.textContent = `${money(short)} to £50`;
      if (minBarFill) minBarFill.style.width = `${percent}%`;
    }
  }

  if (
    basketTotal
  ) {
    basketTotal.innerHTML =
      promotionDiscount > 0
        ? `<span style="text-decoration:line-through;opacity:.55;margin-right:6px;">${money(subtotal)}</span>${money(totalBeforeShipping)}`
        : money(totalBeforeShipping);
  }

  if (
    discountRow
  ) {
    discountRow.innerHTML =
      affiliateDiscount >
      0
        ? `
          <div class="discount-line">
            Affiliate code
            <strong>
              ${escapeHtml(appliedCode.code)}
            </strong>:
            −${money(affiliateDiscount)}
          </div>
        `
        : "";
  }

  if (
    promoRow
  ) {
    const liveNames = livePromotions.map(promo => promo.name).filter(Boolean);
    const appliedLines = promotionResult.applied.map(promo => `
      <div class="discount-line">
        ${escapeHtml(promo.name)} is live:
        −${money(promo.discountPence)}
      </div>
    `).join("");
    const waiting = !appliedLines && liveNames.length
      ? `<div class="discount-line">${escapeHtml(liveNames.join(", "))} is live. Add the qualifying products and it is taken off before any referral code.</div>`
      : "";
    const almost = livePromotions.map(promo => {
      const need = Number(promo.requiredQuantity || 0);
      if (need < 2) return "";
      const have = lineItems
        .filter(item => (promo.productIds || []).includes(Number(item.id)))
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      if (have > 0 && have === need - 1) return `<div class="discount-line">Add 1 more for ${escapeHtml(promo.name)}.</div>`;
      return "";
    }).join("");
    const storeLine = storewideDiscount > 0
      ? `
          <div class="discount-line">
            Store promo
            <strong>
              ${escapeHtml(appliedStorewideCode.code)}
            </strong>:
            −${money(storewideDiscount)}
          </div>
        `
      : "";
    promoRow.innerHTML = appliedLines + waiting + almost + storeLine;
  }

  if (
    totalSavingsRow
  ) {
    totalSavingsRow.innerHTML =
      totalSavings >
      0
        ? `
          <div class="savings-total">
            You save ${money(totalSavings)}
          </div>
        `
        : "";
  }

  if (
    creditRow
  ) {
    creditRow.innerHTML =
      credit > 0
        ? `
          <div class="discount-line">
            Store credit${appliedStoreCredit?.code ? ` <strong>${escapeHtml(appliedStoreCredit.code)}</strong>` : ""}:
            −${money(credit)}
          </div>
          <div class="discount-line">Balance left after this order: ${money(Math.max(0, personalCreditPence - personalCredit))}</div>
        `
        : personalCreditPence > 0
          ? `<div class="discount-line">Store credit available: ${money(personalCreditPence)}</div>`
          : "";
  }

  if (
    !basketLines
  ) {
    return;
  }

  if (
    !entries.length
  ) {
    basketLines.innerHTML = `
      <div class="empty">
        Your basket is empty.
      </div>
    `;

    return;
  }

  const savingBlock = totalSavings > 0
    ? `
      <div class="discount-line">
        Basket ${money(subtotal)}
      </div>
      ${promotionResult.applied.map(promo => `
        <div class="discount-line">
          ${escapeHtml(promo.name)} −${money(promo.discountPence)}
        </div>
      `).join("")}
      ${affiliateDiscount > 0 ? `<div class="discount-line">Referral −${money(affiliateDiscount)}</div>` : ""}
      <div class="savings-total">
        You save ${money(totalSavings)}
      </div>
    `
    : livePromotions.length
      ? `<div class="discount-line">${escapeHtml(livePromotions.map(promo => {
          const end = promo.endsAt ? new Date(promo.endsAt) : null;
          const soon = end && end - Date.now() < 24 * 60 * 60 * 1000;
          return promo.name + (soon ? " (ends tonight)" : end ? " (ends " + end.toLocaleDateString("en-GB") + ")" : "");
        }).join(", "))} is live. The saving shows here once the basket qualifies.</div>`
      : "";

  basketLines.innerHTML =
    savingBlock +
    entries
      .map(
        (
          [
            id,
            qty
          ]
        ) => {
          const p =
            products.find(
              x =>
                Number(
                  x.id
                ) ===
                Number(
                  id
                )
            );

          if (
            !p
          ) {
            return "";
          }

          const price =
            Number(
              p.pricePence ||
              0
            );

          return `
            <div class="basket-line">

              <div>
                <strong>
                  ${escapeHtml(p.name)}
                </strong>

                <br>

                <span>
                  ${qty} × ${money(price)}
                </span>
              </div>

              <div class="basket-right">

                <strong>
                  ${money(
                    price *
                    Number(
                      qty
                    )
                  )}
                </strong>

                <button
                  data-remove="${Number(p.id)}"
                  type="button"
                >
                  Remove
                </button>

              </div>

            </div>
          `;
        }
      )
      .join("");

  document
    .querySelectorAll(
      "[data-remove]"
    )
    .forEach(
      btn => {
        btn.addEventListener(
          "click",
          () => {
            const id =
              Number(
                btn.dataset.remove
              );

            delete basket[id];
            saveBasket();

            postCartEvent(
              id,
              "remove"
            );

            tg
              ?.HapticFeedback
              ?.selectionChanged();

            render();
          }
        );
      }
    );
}


/* =========================================================
   RENDER EVERYTHING
   ========================================================= */

function renderSaved() {
  const panel = document.getElementById("savedPanel");
  if (!panel) return;
  panel.hidden = true;
  panel.innerHTML = "";
}

async function watchRestockCategory(category) {
  try {
    const res = await fetch("/api/restock-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, initData: tg?.initData || "" })
    });
    const data = await res.json();
    setStatus(res.ok ? `We'll message you when ${category} is back.` : (data.error || "Could not set that."), res.ok ? "success" : "error");
  } catch {
    setStatus("Couldn't reach the server.", "error");
  }
}

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
  renderSaved();
}


/* =========================================================
   PRODUCT FETCHING
   ========================================================= */

async function fetchProductsFrom(
  url
) {
  const res =
    await fetch(
      url,
      {
        cache:
          "no-store"
      }
    );

  if (
    !res.ok
  ) {
    throw new Error(
      `${url} returned ${res.status}`
    );
  }

  const data =
    await res.json();

  if (
    !Array.isArray(
      data
    )
  ) {
    throw new Error(
      `${url} did not return a product array`
    );
  }

  return data;
}


function restoreDetails() {
  try {
    const saved = JSON.parse(localStorage.getItem("kage-details") || "null");
    if (!saved) return;
    const name = document.getElementById("name");
    const phone = document.getElementById("phone");
    const address = document.getElementById("address");
    if (name && !name.value) name.value = saved.name || "";
    if (phone && !phone.value) phone.value = saved.phone || "";
    if (address && !address.value) address.value = saved.address || "";
  } catch {}
  if (!localStorage.getItem("kage-seen-first")) {
    setStatus("First order: add items, enter your name and address, then pay the exact USDT amount and paste the hash.", "");
    localStorage.setItem("kage-seen-first", "1");
  }
}

async function loadShopStatus() {
  try {
    const res = await fetch("/api/shop-status", { cache: "no-store" });
    const data = await res.json();
    if (data.open === false) {
      const productsContainer = document.getElementById("products");
      if (productsContainer) {
        productsContainer.insertAdjacentHTML("afterbegin", `<div class="catalogue-error">Back shortly. The shop is closed while stock is being updated.</div>`);
      }
      const checkoutBtn = document.getElementById("checkoutBtn");
      if (checkoutBtn) checkoutBtn.disabled = true;
    }
  } catch {}
}

async function restoreOpenOrder() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("kage-open-order") || "null"); } catch {}
  if (!saved?.orderId) return;
  try {
    const res = await fetch(`/api/orders/${saved.orderId}`, { cache: "no-store" });
    if (!res.ok) {
      localStorage.removeItem("kage-open-order");
      return;
    }
    const order = await res.json();
    if (order.paymentStatus !== "awaiting_payment" && order.paymentStatus !== "payment_submitted") {
      localStorage.removeItem("kage-open-order");
      return;
    }
    setStatus(`Order #${order.orderId} is still open — total ${money(order.totalPence)}.`, "success");
    renderPaymentPanel(order);
    document.getElementById("paymentPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {}
}

async function watchRestock(productId) {
  try {
    const res = await fetch("/api/restock-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, initData: tg?.initData || "" })
    });
    const data = await res.json();
    setStatus(res.ok ? "We'll message you when it's back." : (data.error || "Could not set the alert."), res.ok ? "success" : "error");
  } catch {
    setStatus("Couldn't reach the server.", "error");
  }
}

async function loadProducts() {
  const productsContainer =
    document.getElementById(
      "products"
    );

  try {
    products =
      await fetchProductsFrom(
        "/products.json"
      );

  } catch (
    firstError
  ) {
    console.warn(
      "/products.json failed",
      firstError
    );

    try {
      products =
        await fetchProductsFrom(
          "/api/products"
        );

    } catch (
      secondError
    ) {
      console.error(
        "Both product endpoints failed",
        secondError
      );

      products =
        [];

      if (
        productsContainer
      ) {
        productsContainer.innerHTML = `
          <div class="catalogue-error">
            The catalogue could not be loaded from the server.
            Refresh the Mini App after the latest deployment finishes.
          </div>
        `;
      }

      return;
    }
  }

  rebuildCatalogueNavigation();
  render();
  loadPromotions();
  restoreOpenOrder();
  loadShopStatus();
  restoreDetails();
}


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(
  message,
  kind = ""
) {
  const status =
    document.getElementById(
      "status"
    );

  if (
    !status
  ) {
    return;
  }

  status.textContent =
    message;

  status.className =
    `status ${kind}`;
}


/* =========================================================
   AFFILIATE CODE
   ========================================================= */

async function applyDiscountCode() {
  const input =
    document.getElementById(
      "discountCode"
    );

  const code =
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedCode =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/discount-codes/${encodeURIComponent(code)}`
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      !data.valid
    ) {
      appliedCode =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That affiliate code isn't valid.",
        "error"
      );

      return;
    }

    appliedCode = {
      code:
        data.code,

      discountType:
        data.discountType,

      discountValue:
        data.discountValue
    };

    setStatus(
      `${data.code} applied.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that affiliate code. Try again.",
      "error"
    );
  }
}


/* =========================================================
   STOREWIDE CODE
   ========================================================= */

async function applyStorewideCode() {
  const input =
    document.getElementById(
      "storewideCode"
    );

  const code =
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedStorewideCode =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/storewide-promo/${encodeURIComponent(code)}`
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      !data.valid
    ) {
      appliedStorewideCode =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That store promo isn't active.",
        "error"
      );

      return;
    }

    appliedStorewideCode = {
      code:
        data.code,

      discountPercent:
        Number(
          data.discountPercent ||
          0
        )
    };

    setStatus(
      `${data.code} applied — extra ${data.discountPercent}% off.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that store promo. Try again.",
      "error"
    );
  }
}


/* =========================================================
   STORE CREDIT
   ========================================================= */

async function applyStoreCredit() {
  const input =
    document.getElementById(
      "storeCreditCode"
    );

  const code =
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedStoreCredit =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/referral-codes/${encodeURIComponent(code)}/earnings?username=${encodeURIComponent(telegramUser?.username || "")}`
      );

    const data =
      await res.json();

    if (
      !res.ok
    ) {
      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That store credit code isn't valid.",
        "error"
      );

      return;
    }

    if (
      !data.balancePence ||
      Number(
        data.balancePence
      ) <=
      0
    ) {
      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        "No store credit is available on that code.",
        "error"
      );

      return;
    }

    appliedStoreCredit = {
      code:
        data.code,

      balancePence:
        Number(
          data.balancePence
        )
    };

    setStatus(
      `Store credit applied: ${money(data.balancePence)} available.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that store credit code. Try again.",
      "error"
    );
  }
}


/* =========================================================
   SUBMIT ORDER
   ========================================================= */

async function submitOrder() {
  const customerName =
    document
      .getElementById(
        "name"
      )
      ?.value
      .trim();

  const telegramUsername =
    telegramUser?.username
      ? `@${telegramUser.username}`
      : document.getElementById("handle")?.value.trim();

  const phone =
    document
      .getElementById(
        "phone"
      )
      ?.value
      .trim();

  const address =
    document
      .getElementById(
        "address"
      )
      ?.value
      .trim();

  const items =
    Object
      .entries(
        basket
      )
      .map(
        (
          [
            id,
            quantity
          ]
        ) => ({
          id:
            Number(
              id
            ),

          quantity:
            Number(
              quantity
            )
        })
      );

  if (
    !items.length
  ) {
    setStatus(
      "Your basket is empty.",
      "error"
    );

    return;
  }

  if (
    !customerName ||
    !phone ||
    !address
  ) {
    setStatus(
      "Please add your name, phone number, and delivery address.",
      "error"
    );

    return;
  }

  const checkoutBtn =
    document.getElementById(
      "checkoutBtn"
    );

  if (
    checkoutBtn
  ) {
    checkoutBtn.disabled =
      true;
  }

  setStatus(
    "Checking stock…"
  );

  try {
    const fresh = await fetchProductsFrom("/api/products");
    const short = [];
    for (const item of items) {
      const product = fresh.find(entry => Number(entry.id) === Number(item.id));
      const available = Number(product?.stock ?? 0);
      if (!product || available < item.quantity) {
        short.push(`${product?.name || "An item"}: only ${Math.max(0, available)} left`);
        if (available <= 0) delete basket[item.id];
        else basket[item.id] = available;
      }
    }
    if (short.length) {
      saveBasket();
      render();
      setStatus(`Stock changed before checkout.\n${short.join("\n")}\nYour basket has been updated.`, "error");
      return;
    }
  } catch {}

  setStatus(
    "Placing your order…"
  );

  try {
    const res =
      await fetch(
        "/api/orders",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              customerName,

              telegramUsername,
              phone,

              telegramId:
                telegramUser?.id ||
                undefined,

              address,

              items,

              discountCode:
                appliedCode?.code ||
                undefined,

              storewideCode:
                appliedStorewideCode?.code ||
                undefined,

              storeCreditCode:
                appliedStoreCredit?.code ||
                undefined,

              referredByHandle:
                document.getElementById("referHandle")?.value.trim() ||
                undefined,

              initData:
                tg?.initData ||
                undefined
            })
        }
      );

    const data =
      await res.json();

    if (
      !res.ok
    ) {
      setStatus(
        data.error ||
        "Something went wrong placing your order.",
        "error"
      );

      return;
    }

    setStatus(
      `Order #${data.orderId} created — total ${money(data.totalPence)} including shipping.`,
      "success"
    );
    try { localStorage.setItem("kage-open-order", JSON.stringify({ orderId: data.orderId })); } catch {}
    try {
      localStorage.setItem("kage-details", JSON.stringify({
        name: customerName,
        phone,
        address
      }));
    } catch {}

    Object
      .keys(
        basket
      )
      .forEach(
        id =>
          delete basket[id]
      );
    saveBasket();

    appliedCode =
      null;

    appliedStorewideCode =
      null;

    appliedStoreCredit =
      null;

    const discountInput =
      document.getElementById(
        "discountCode"
      );

    const promoInput =
      document.getElementById(
        "storewideCode"
      );

    const creditInput =
      document.getElementById(
        "storeCreditCode"
      );

    if (
      discountInput
    ) {
      discountInput.value =
        "";
    }

    if (
      promoInput
    ) {
      promoInput.value =
        "";
    }

    if (
      creditInput
    ) {
      creditInput.value =
        "";
    }

    render();

    renderPaymentPanel(
      data
    );

    document
      .getElementById(
        "paymentPanel"
      )
      ?.scrollIntoView({
        behavior:
          "smooth",

        block:
          "start"
      });

  } catch (
    err
  ) {
    console.error(
      "ORDER ERROR:",
      err
    );

    setStatus(
      "Couldn't reach the server. Try again.",
      "error"
    );

  } finally {
    if (
      checkoutBtn
    ) {
      checkoutBtn.disabled =
        false;
    }
  }
}


/* =========================================================
   COPY WALLET ADDRESS
   ========================================================= */

async function copyWalletAddress(
  address
) {
  const cleanAddress =
    String(
      address ||
      ""
    ).trim();

  if (
    !cleanAddress
  ) {
    return false;
  }

  /*
    Modern clipboard.
  */

  try {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator
        .clipboard
        .writeText(
          cleanAddress
        );

      return true;
    }

  } catch (
    err
  ) {
    console.warn(
      "Clipboard API failed:",
      err
    );
  }

  /*
    iPhone / Safari / Telegram fallback.
  */

  try {
    const textarea =
      document.createElement(
        "textarea"
      );

    textarea.value =
      cleanAddress;

    textarea.style.position =
      "fixed";

    textarea.style.left =
      "-9999px";

    textarea.style.top =
      "0";

    textarea.style.opacity =
      "0";

    textarea.style.fontSize =
      "16px";

    document.body.appendChild(
      textarea
    );

    textarea.focus();
    textarea.select();

    textarea.setSelectionRange(
      0,
      textarea.value.length
    );

    const copied =
      document.execCommand(
        "copy"
      );

    document.body.removeChild(
      textarea
    );

    return Boolean(
      copied
    );

  } catch (
    err
  ) {
    console.error(
      "Fallback copy failed:",
      err
    );

    return false;
  }
}


/* =========================================================
   PAYMENT PANEL
   ========================================================= */

function renderPaymentPanel(
  order
) {
  const panel =
    document.getElementById(
      "paymentPanel"
    );

  if (
    !panel
  ) {
    return;
  }

  if (
    !order.payment ||
    order.payment.method !==
      "crypto"
  ) {
    panel.innerHTML =
      "";

    return;
  }

  const walletAddress =
    String(
      order.payment.address ||
      ""
    ).trim();

  const quote =
    order.payment.quote?.USDT ??
    "QUOTE_PENDING";

  const reservationMinutes =
    Number(
      order.reservationMinutes ||
      30
    );

  const reservationExpiresAt =
    order.stockReservationExpiresAt ||
    null;

  panel.innerHTML = `
    <div class="payment-panel">

      <div class="payment-title">
        Send the exact amount
      </div>

      <div class="payment-network">
        USDT on Ethereum, ERC-20 only
      </div>

      <div class="payment-wallet-label">
        Wallet Address
      </div>

      <div
        id="walletAddress"
        class="payment-address"
        tabindex="0"
      >
        ${escapeHtml(walletAddress)}
      </div>

      <button
        id="copyWalletBtn"
        class="gold-btn copy-wallet-btn"
        type="button"
      >
        📋 Copy Wallet Address
      </button>

      <div
        id="walletCopyStatus"
        class="wallet-copy-status"
      >
        You can also press and hold the address above to copy it.
      </div>

      <div class="payment-quote">
        ${escapeHtml(quote)} USDT
      </div>
      <button id="copyAmountBtn" class="gold-btn copy-wallet-btn" type="button">Copy amount</button>

      <div class="payment-sub">
        ${escapeHtml(
          order.payment.instructions ||
          ""
        )}
        <br><br>
        Usually dispatched within 1–2 days once payment is confirmed.
        ${order.referralCreditDue ? "<br>£10 credit once this is confirmed." : ""}
        If this page closes, open the shop again and this order will still be here.
        ${localStorage.getItem("kage-seen-crypto") ? "" : "<br><br>A hash looks like 0x followed by 64 letters and numbers. Paste the whole thing."}
      </div>

      ${
        reservationExpiresAt
          ? `
            <div class="payment-reservation">
              ⏳ Stock reserved for ${reservationMinutes} minutes
            </div>

            <div
              id="reservationCountdown"
              class="reservation-countdown"
            ></div>
          `
          : ""
      }

      <label for="paymentTxId">
        Transaction hash
      </label>

      <input
        id="paymentTxId"
        type="text"
        placeholder="0x..."
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      >

      <button
        id="confirmPaymentBtn"
        class="gold-btn"
        type="button"
      >
        I've paid
      </button>
      <button id="addToOrderBtn" class="code-btn" type="button" style="margin-top:8px;">Add current basket to this order</button>
      <div class="payment-sub">Posts Monday 12pm, Wednesday 12pm, Friday 10am. ${nextDispatchText()}</div>

      <div
        id="paymentStatus"
        class="status"
      ></div>

    </div>
  `;


/* =========================================================
   COPY BUTTON
   ========================================================= */

  document.getElementById("addToOrderBtn")?.addEventListener("click", async () => {
    const items = Object.entries(basket).map(([id, quantity]) => ({ id: Number(id), quantity: Number(quantity) }));
    if (!items.length) return setStatus("Add items to the basket first.", "error");
    const res = await fetch(`/api/orders/${order.orderId}/add-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, initData: tg?.initData || "" })
    });
    const data = await res.json();
    if (!res.ok) return setStatus(data.error || "Could not add those items.", "error");
    Object.keys(basket).forEach(id => delete basket[id]);
    saveBasket();
    setStatus(`Added. Order #${data.orderId} is now ${money(data.totalPence)}.`, "success");
    order.totalPence = data.totalPence;
    order.payment.quote.USDT = data.quotedUsdt;
    renderPaymentPanel(order);
  });

  document.getElementById("copyAmountBtn")?.addEventListener("click", async () => {
    const copied = await copyWalletAddress(String(quote));
    const status = document.getElementById("walletCopyStatus");
    if (status) status.textContent = copied ? "Amount copied." : "Could not copy the amount.";
  });

  const copyButton =
    document.getElementById(
      "copyWalletBtn"
    );

  const copyStatus =
    document.getElementById(
      "walletCopyStatus"
    );

  copyButton
    ?.addEventListener(
      "click",

      async () => {
        if (
          !walletAddress
        ) {
          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "Wallet address isn't available.";
          }

          return;
        }

        try {
          tg
            ?.HapticFeedback
            ?.impactOccurred(
              "light"
            );
        } catch {}

        const copied =
          await copyWalletAddress(
            walletAddress
          );

        if (
          copied
        ) {
          if (
            copyButton
          ) {
            copyButton.textContent =
              "✅ Address Copied";
          }

          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "✅ Wallet address copied to clipboard";
          }

          setTimeout(
            () => {
              if (
                copyButton
              ) {
                copyButton.textContent =
                  "📋 Copy Wallet Address";
              }

              if (
                copyStatus
              ) {
                copyStatus.textContent =
                  "You can also press and hold the address above to copy it.";
              }
            },

            2000
          );

        } else {
          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "Couldn't copy automatically — press and hold the address above and choose Copy.";
          }
        }
      }
    );


/* =========================================================
   PAYMENT BUTTON
   ========================================================= */

  document
    .getElementById(
      "confirmPaymentBtn"
    )
    ?.addEventListener(
      "click",

      () =>
        confirmPayment(
          order.orderId
        )
    );


/* =========================================================
   COUNTDOWN
   ========================================================= */

  if (
    reservationExpiresAt
  ) {
    startPaymentCountdown(
      reservationExpiresAt
    );
  }
}


/* =========================================================
   RESERVATION COUNTDOWN
   ========================================================= */

function startPaymentCountdown(
  expiresAt
) {
  const element =
    document.getElementById(
      "reservationCountdown"
    );

  if (
    !element
  ) {
    return;
  }

  if (
    paymentCountdownTimer
  ) {
    clearInterval(
      paymentCountdownTimer
    );

    paymentCountdownTimer =
      null;
  }

  const expiryTime =
    new Date(
      expiresAt
    ).getTime();

  function updateCountdown() {
    const remaining =
      expiryTime -
      Date.now();

    if (
      !Number.isFinite(
        remaining
      ) ||
      remaining <=
        0
    ) {
      element.textContent =
        "⌛ Reservation expired";

      element.classList.add(
        "expired"
      );

      if (
        paymentCountdownTimer
      ) {
        clearInterval(
          paymentCountdownTimer
        );

        paymentCountdownTimer =
          null;
      }

      return;
    }

    const totalSeconds =
      Math.ceil(
        remaining /
        1000
      );

    const minutes =
      Math.floor(
        totalSeconds /
        60
      );

    const seconds =
      totalSeconds %
      60;

    element.textContent =
      `⏳ Time remaining: ${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  updateCountdown();

  paymentCountdownTimer =
    setInterval(
      updateCountdown,
      1000
    );
}


/* =========================================================
   SUBMIT PAYMENT HASH
   ========================================================= */

async function confirmPayment(
  orderId
) {
  const transactionId =
    document
      .getElementById(
        "paymentTxId"
      )
      ?.value
      .trim();

  const paymentStatus =
    document.getElementById(
      "paymentStatus"
    );

  const setPaymentStatus = (
    message,
    kind = ""
  ) => {
    if (
      !paymentStatus
    ) {
      return;
    }

    paymentStatus.textContent =
      message;

    paymentStatus.className =
      `status ${kind}`;
  };

  if (
    !transactionId
  ) {
    setPaymentStatus(
      "Enter your transaction hash.",
      "error"
    );

    return;
  }

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(
      transactionId
    )
  ) {
    setPaymentStatus(
      "Enter a valid Ethereum transaction hash.",
      "error"
    );

    return;
  }

  const btn =
    document.getElementById(
      "confirmPaymentBtn"
    );

  if (
    btn
  ) {
    btn.disabled =
      true;

    btn.textContent =
      "Submitting...";
  }

  setPaymentStatus(
    "Submitting transaction for confirmation…"
  );

  try {
    const res =
      await fetch(
        `/api/orders/${orderId}/confirm-payment`,

        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              transactionId
            })
        }
      );

    let data =
      {};

    try {
      data =
        await res.json();

    } catch {}

    if (
      !res.ok
    ) {
      if (
        res.status ===
        410
      ) {
        setPaymentStatus(
          data.error ||
          "This order has expired and the stock has been returned to the shop.",
          "error"
        );

        if (
          paymentCountdownTimer
        ) {
          clearInterval(
            paymentCountdownTimer
          );

          paymentCountdownTimer =
            null;
        }

        return;
      }

      setPaymentStatus(
        data.error ||
        "Could not submit payment.",
        "error"
      );

      return;
    }

    setPaymentStatus(
      "✅ Payment submitted. We'll confirm it shortly.",
      "success"
    );
    try { localStorage.setItem("kage-seen-crypto", "1"); } catch {}
    Object.keys(basket).forEach(id => delete basket[id]);
    saveBasket();
    try { localStorage.removeItem("kage-open-order"); } catch {}
    render();

    /*
      Once the transaction hash has been
      accepted, stop showing the countdown.

      The server keeps the stock reserved
      while the payment is checked.
    */

    if (
      paymentCountdownTimer
    ) {
      clearInterval(
        paymentCountdownTimer
      );

      paymentCountdownTimer =
        null;
    }

    const countdown =
      document.getElementById(
        "reservationCountdown"
      );

    if (
      countdown
    ) {
      countdown.textContent =
        "✅ Transaction submitted — stock remains reserved while payment is checked.";

      countdown.classList.remove(
        "expired"
      );
    }

    if (
      btn
    ) {
      btn.textContent =
        "✅ Transaction Submitted";
    }

    try {
      tg
        ?.HapticFeedback
        ?.notificationOccurred(
          "success"
        );
    } catch {}

  } catch (
    err
  ) {
    console.error(
      "PAYMENT SUBMISSION ERROR:",
      err
    );

    setPaymentStatus(
      "Couldn't reach the server. Try again.",
      "error"
    );

  } finally {
    if (
      btn &&
      !paymentStatus
        ?.classList
        .contains(
          "success"
        )
    ) {
      btn.disabled =
        false;

      btn.textContent =
        "I've paid — submit transaction";
    }
  }
}


/* =========================================================
   BUTTON LISTENERS
   ========================================================= */

document
  .getElementById(
    "applyDiscount"
  )
  ?.addEventListener(
    "click",
    applyDiscountCode
  );

document
  .getElementById(
    "applyStorewide"
  )
  ?.addEventListener(
    "click",
    applyStorewideCode
  );

document
  .getElementById(
    "applyStoreCredit"
  )
  ?.addEventListener(
    "click",
    applyStoreCredit
  );

document
  .getElementById(
    "checkoutBtn"
  )
  ?.addEventListener(
    "click",
    submitOrder
  );

document
  .getElementById(
    "cartJump"
  )
  ?.addEventListener(
    "click",
    () => {
      document
        .getElementById(
          "checkout"
        )
        ?.scrollIntoView({
          behavior:
            "smooth"
        });
    }
  );

document
  .getElementById(
    "basketBar"
  )
  ?.addEventListener(
    "click",
    () => {
      document
        .getElementById(
          "checkout"
        )
        ?.scrollIntoView({
          behavior:
            "smooth"
        });
    }
  );


/* =========================================================
   TELEGRAM USERNAME
   ========================================================= */

if (
  telegramUser?.username
) {
  const handleInput =
    document.getElementById(
      "handle"
    );

  if (handleInput) {
    handleInput.value = `@${telegramUser.username}`;
    handleInput.readOnly = true;
    handleInput.disabled = true;
  }
}

const addressInput = document.getElementById("address");
if (addressInput && !document.getElementById("phone")) {
  const label = document.createElement("label");
  label.textContent = "Phone number";
  const input = document.createElement("input");
  input.id = "phone";
  input.type = "tel";
  input.placeholder = "Phone number for delivery";
  input.required = true;
  addressInput.insertAdjacentElement("afterend", input);
  input.insertAdjacentElement("beforebegin", label);
}


/* =========================================================
   START SHOP
   ========================================================= */


loadProducts();
loadPersonalCredit();
