import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

/**
 * Promotions Manager + price overrides for the Kage Telegram shop bot.
 *
 * Drop this next to server.js and wire the hooks in INTEGRATION.md.
 *
 * What this adds (admin-only, persisted in SQLite):
 * - View product IDs (already in the bot; this module can render the same list)
 * - Create / edit / pause / delete promotions
 * - Change a product's selling price without editing products.json
 * - Server-side promo calculation at checkout
 * - Conflict protection: a product can only sit in one ACTIVE promotion
 *
 * Promotion types:
 * - percent: X% off each eligible unit (requiredQuantity defaults to 1)
 * - fixed_amount: £X off each eligible unit
 * - fixed_bundle: N eligible units for a fixed bundle price
 *   (repeats for each complete bundle; leftover units stay full price)
 *
 * RT40 is not in the current bot. It is not an affiliate code and it is
 * not the store-wide WEEKEND10 promo. Create it from the manager if you
 * want a 40% code-style offer — or use type "percent" and discount 40
 * on the product IDs that should get it. This module does not invent RT40.
 */

function initPromotions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS price_overrides (
      product_id INTEGER PRIMARY KEY,
      price_pence INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const insertPromotionStmt = db.prepare(`
    INSERT INTO promotions (json) VALUES (?)
  `);

  const updatePromotionStmt = db.prepare(`
    UPDATE promotions SET json = ? WHERE id = ?
  `);

  const deletePromotionStmt = db.prepare(`
    DELETE FROM promotions WHERE id = ?
  `);

  const upsertPriceStmt = db.prepare(`
    INSERT INTO price_overrides (product_id, price_pence, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(product_id)
    DO UPDATE SET
      price_pence = excluded.price_pence,
      updated_at = excluded.updated_at
  `);

  const deletePriceStmt = db.prepare(`
    DELETE FROM price_overrides WHERE product_id = ?
  `);

  const getPriceStmt = db.prepare(`
    SELECT price_pence FROM price_overrides WHERE product_id = ?
  `);

  function loadPromotions() {
    return db.prepare(`SELECT id, json FROM promotions ORDER BY id`).all()
      .map(row => {
        try {
          const promo = JSON.parse(row.json);
          promo.id = Number(row.id);
          return promo;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function savePromotion(promo) {
    const payload = JSON.stringify({
      ...promo,
      id: undefined
    });

    if (promo.id) {
      updatePromotionStmt.run(payload, Number(promo.id));
      return Number(promo.id);
    }

    const result = insertPromotionStmt.run(payload);
    return Number(result.lastInsertRowid);
  }

  function getPromotion(id) {
    return loadPromotions().find(promo => promo.id === Number(id)) || null;
  }

  function getPriceOverride(productId) {
    const row = getPriceStmt.get(Number(productId));
    if (!row) return null;
    const price = Number(row.price_pence);
    return Number.isInteger(price) && price >= 0 ? price : null;
  }

  function setPriceOverride(productId, pricePence) {
    upsertPriceStmt.run(
      Number(productId),
      Number(pricePence),
      new Date().toISOString()
    );
  }

  function clearPriceOverride(productId) {
    deletePriceStmt.run(Number(productId));
  }

  function deletePromotion(id) {
    deletePromotionStmt.run(Number(id));
  }

  return {
    loadPromotions,
    savePromotion,
    getPromotion,
    deletePromotion,
    getPriceOverride,
    setPriceOverride,
    clearPriceOverride
  };
}

function getEffectivePricePence(product, getPriceOverride) {
  const override = getPriceOverride(Number(product.id));
  if (override !== null) return override;
  return Number(product.pricePence);
}

/**
 * Active promotions that already use any of these product IDs.
 * Pass ignoreId when editing so a promo does not conflict with itself.
 */
function findPromotionConflicts(promotions, productIds, ignoreId = null) {
  const wanted = new Set(productIds.map(Number));
  const conflicts = [];

  for (const promo of promotions) {
    if (!promo.active) continue;
    if (ignoreId && Number(promo.id) === Number(ignoreId)) continue;

    const overlap = (promo.productIds || [])
      .map(Number)
      .filter(id => wanted.has(id));

    if (overlap.length) {
      conflicts.push({
        promotionId: promo.id,
        name: promo.name,
        productIds: overlap
      });
    }
  }

  return conflicts;
}

/**
 * Apply active promotions to priced line items.
 * lineItems: [{ id, name, quantity, pricePence }]
 * Returns discount plus a breakdown. Does not mutate input.
 *
 * Bundle rule: only complete bundles are discounted.
 * Percent / fixed_amount: every eligible unit is discounted.
 * One product, one active promo — guaranteed by conflict checks —
 * so discounts are summed, never stacked on the same unit.
 */
function calculatePromotionDiscount(lineItems, promotions) {
  const active = (promotions || []).filter(promo => promo.active);
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
        units.push({ id: Number(item.id), pricePence: price, name: item.name });
      }
    }

    if (!units.length) continue;

    const required = Math.max(1, Number(promo.requiredQuantity || 1));
    let discount = 0;
    let bundles = 0;

    if (promo.type === "fixed_bundle") {
      bundles = Math.floor(units.length / required);
      if (!bundles) continue;

      const bundleUnits = units
        .slice()
        .sort((a, b) => b.pricePence - a.pricePence)
        .slice(0, bundles * required);

      const normal = bundleUnits.reduce((sum, unit) => sum + unit.pricePence, 0);
      const bundled = bundles * Number(promo.bundlePricePence || 0);
      discount = Math.max(0, normal - bundled);
    } else {
      const qualifying = Math.floor(units.length / required) * required;
      if (!qualifying) continue;

      const chosen = units.slice(0, qualifying);
      bundles = qualifying / required;

      if (promo.type === "fixed_amount") {
        const perUnit = Number(promo.discountPence || 0);
        discount = chosen.reduce(
          (sum, unit) => sum + Math.min(unit.pricePence, perUnit),
          0
        );
      } else {
        const percent = Number(promo.discountPercent || 0);
        discount = chosen.reduce(
          (sum, unit) => sum + Math.round(unit.pricePence * (percent / 100)),
          0
        );
      }
    }

    discount = Math.max(0, discount);
    if (!discount) continue;

    promotionDiscountPence += discount;
    applied.push({
      id: promo.id,
      name: promo.name,
      type: promo.type,
      discountPence: discount,
      bundles,
      stackWithAffiliate: promo.stackWithAffiliate !== false
    });
  }

  return {
    promotionDiscountPence,
    applied
  };
}

function formatPromotion(promo, money) {
  const ids = (promo.productIds || []).join(", ") || "none";
  const status = promo.active ? "🟢 ACTIVE" : "🔴 PAUSED";
  let rule = "";

  if (promo.type === "fixed_bundle") {
    rule = `${promo.requiredQuantity} for ${money(promo.bundlePricePence)}`;
  } else if (promo.type === "fixed_amount") {
    rule = `${money(promo.discountPence)} off each eligible unit`;
    if (Number(promo.requiredQuantity) > 1) {
      rule += ` (buy ${promo.requiredQuantity})`;
    }
  } else {
    rule = `${promo.discountPercent}% off`;
    if (Number(promo.requiredQuantity) > 1) {
      rule += ` when buying ${promo.requiredQuantity}`;
    }
  }

  return [
    `#${promo.id} ${promo.name}`,
    status,
    `Type: ${promo.type}`,
    `Rule: ${rule}`,
    `Product IDs: ${ids}`,
    `Stacks with affiliate code: ${promo.stackWithAffiliate === false ? "NO" : "YES"}`
  ].join("\n");
}

function parseProductIds(text) {
  const ids = String(text || "")
    .split(/[^0-9]+/)
    .map(part => Number(part))
    .filter(id => Number.isInteger(id) && id > 0);

  return [...new Set(ids)];
}

function parseMoneyToPence(text) {
  const cleaned = String(text || "").replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

/* =========================================================
   ENVIRONMENT
   ========================================================= */

const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN;

const receivingAddress =
  process.env.ETH_RECEIVING_ADDRESS || "";

const etherscanApiKey =
  process.env.ETHERSCAN ||
  process.env.ETHERSCAN_API_KEY ||
  "";

const webAppUrl =
  process.env.WEBAPP_URL || "";

/* =========================================================
   ADMINS
   ========================================================= */

const ownerTelegramId =
  String(
    process.env.OWNER_TELEGRAM_ID ||
    ""
  ).trim();

const singleAdminId =
  String(
    process.env.ADMIN_TELEGRAM_ID ||
    ""
  ).trim();

const adminIdsFromEnv =
  String(
    process.env.ADMIN_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const configuredAdminIds =
  new Set(
    [
      ownerTelegramId,
      singleAdminId,
      ...adminIdsFromEnv
    ].filter(Boolean)
  );

const adminTelegramId =
  ownerTelegramId ||
  singleAdminId ||
  adminIdsFromEnv[0] ||
  "";

const DATA_DIR =
  process.env.DATA_DIR || ".";

const supportTelegramIds =
  (process.env.SUPPORT_TELEGRAM_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

/* =========================================================
   SHOP SETTINGS
   ========================================================= */

const MINIMUM_ORDER_PENCE = 5000;
const SHIPPING_PENCE = 500;
const LOW_STOCK_THRESHOLD = 5;
const STOCK_RESERVATION_MINUTES = 30;
const STOCK_RESERVATION_MS = STOCK_RESERVATION_MINUTES * 60 * 1000;

/* =========================================================
   AFFILIATE CODES
   ========================================================= */

const AFFILIATE_DISCOUNT_PERCENT = 10;
const AFFILIATE_COMMISSION_PERCENT = 5;

const affiliateCodes = [
  { code: "Y8", owner: "@Y8_JKO" },
  { code: "TWARD", owner: "@tward1994" },
  { code: "CHODE10", owner: "@Hex_case" },
  { code: "DOMINATE", owner: "@dom_harriss" },
  { code: "STEVIEWONDER", owner: "@Steviewonder987" },
  { code: "KITTYSJ10", owner: "@Sjobje" },
  { code: "DABBLE", owner: "@Peachy001" },
  { code: "JAM97", owner: "@Jam97" },
  { code: "BENS33", owner: "@SuperSeiyanGoku33", discountPercent: 33 }
];

/* =========================================================
   STORE-WIDE PROMO
   ========================================================= */

// The promo has no start/end date. It is controlled manually
// from the Telegram admin dashboard and stays in its saved state
// across restarts/redeploys.
const STOREWIDE_PROMO_DEFAULTS = {
  code: "WEEKEND10",
  discountPercent: 10,
  active: false
};

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(express.json({ limit: "1mb" }));

/* =========================================================
   DATABASE
   ========================================================= */

mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(
  path.join(DATA_DIR, "kage.sqlite")
);

const promotionsApi = initPromotions(db);

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_codes (
  code TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_earnings (
  code TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  productId INTEGER NOT NULL,
  action TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id INTEGER PRIMARY KEY,
  stock INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  telegram_id TEXT,
  display_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  review_text TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

/* =========================================================
   DATABASE STATEMENTS
   ========================================================= */

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, json)
  VALUES (?, ?)
  ON CONFLICT(id)
  DO UPDATE SET json = excluded.json
`);

const upsertDiscountStmt = db.prepare(`
  INSERT INTO discount_codes (code, json)
  VALUES (?, ?)
  ON CONFLICT(code)
  DO UPDATE SET json = excluded.json
`);

const upsertReferralStmt = db.prepare(`
  INSERT INTO referral_earnings (code, json)
  VALUES (?, ?)
  ON CONFLICT(code)
  DO UPDATE SET json = excluded.json
`);

const upsertMetaStmt = db.prepare(`
  INSERT INTO meta (key, value)
  VALUES (?, ?)
  ON CONFLICT(key)
  DO UPDATE SET value = excluded.value
`);

const insertCartEventStmt = db.prepare(`
  INSERT INTO cart_events (productId, action, createdAt)
  VALUES (?, ?, ?)
`);

const insertInventoryStmt = db.prepare(`
  INSERT OR IGNORE INTO inventory (product_id, stock)
  VALUES (?, ?)
`);

const getInventoryStmt = db.prepare(`
  SELECT stock
  FROM inventory
  WHERE product_id = ?
`);

const setInventoryStmt = db.prepare(`
  UPDATE inventory
  SET stock = ?
  WHERE product_id = ?
`);

const reserveInventoryStmt = db.prepare(`
  UPDATE inventory
  SET stock = stock - ?
  WHERE product_id = ?
    AND stock >= ?
`);

const restoreInventoryStmt = db.prepare(`
  UPDATE inventory
  SET stock = stock + ?
  WHERE product_id = ?
`);

/* =========================================================
   PRODUCT CATALOGUE
   ========================================================= */

let products = [];

try {
  products = JSON.parse(
    readFileSync(
      path.join(__dirname, "public", "products.json"),
      "utf8"
    )
  );

  if (!Array.isArray(products)) {
    throw new Error("products.json must contain an array.");
  }
} catch (err) {
  console.error("PRODUCT LOAD ERROR:", err);
  process.exit(1);
}

const productsById = new Map(
  products.map(product => [
    Number(product.id),
    product
  ])
);

/* =========================================================
   INITIALISE LIVE INVENTORY
   ========================================================= */

for (const product of products) {
  const id = Number(product.id);
  const originalStock = Number(product.stock);

  if (!Number.isInteger(id)) {
    continue;
  }

  if (Number.isFinite(originalStock)) {
    insertInventoryStmt.run(
      id,
      Math.max(0, Math.floor(originalStock))
    );
  }
}

/* =========================================================
   LIVE PRODUCT HELPERS
   ========================================================= */

function getLiveStock(productId) {
  const row = getInventoryStmt.get(
    Number(productId)
  );

  if (!row) {
    return null;
  }

  return Number(row.stock);
}

function getLiveProducts() {
  return products.map(product => {
    const liveStock = getLiveStock(
      product.id
    );

    return {
      ...product,
      stock:
        liveStock !== null
          ? liveStock
          : product.stock,
      cataloguePricePence: Number(product.pricePence),
      pricePence: getEffectivePricePence(
        product,
        promotionsApi.getPriceOverride
      ),
      priceOverridden:
        promotionsApi.getPriceOverride(product.id) !== null
    };
  });
}

/* =========================================================
   LIVE PRODUCTS
   ========================================================= */

app.get("/products.json", (_req, res) => {
  res.json(getLiveProducts());
});

app.get("/api/products", (_req, res) => {
  res.json(getLiveProducts());
});

app.get("/api/promotions", (_req, res) => {
  res.json(
    promotionsApi.loadPromotions()
      .filter(promo => promo.active)
      .map(promo => ({
        id: promo.id,
        name: promo.name,
        type: promo.type,
        productIds: promo.productIds,
        requiredQuantity: promo.requiredQuantity,
        discountPercent: promo.discountPercent || 0,
        discountPence: promo.discountPence || 0,
        bundlePricePence: promo.bundlePricePence || 0,
        stackWithAffiliate: promo.stackWithAffiliate !== false
      }))
  );
});


/* =========================================================
   SPINNING LOGO IN THE MINI APP
   ========================================================= */


app.post("/api/basket-quote", (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const lineItems = [];
  let subtotalPence = 0;

  for (const rawItem of items) {
    const id = Number(rawItem?.id);
    const quantity = Number(rawItem?.quantity);
    const product = productsById.get(id);
    if (!product || !Number.isInteger(quantity) || quantity <= 0) continue;
    const pricePence = getEffectivePricePence(product, promotionsApi.getPriceOverride);
    subtotalPence += pricePence * quantity;
    lineItems.push({
      id,
      name: product.name,
      quantity,
      pricePence
    });
  }

  const promotionResult = calculatePromotionDiscount(
    lineItems,
    promotionsApi.loadPromotions().filter(promo => promo.active)
  );

  return res.json({
    subtotalPence,
    promotionDiscountPence: promotionResult.promotionDiscountPence,
    appliedPromotions: promotionResult.applied,
    totalBeforeCodesPence: Math.max(0, subtotalPence - promotionResult.promotionDiscountPence),
    note: "Promotion is applied before referral codes, store credit, and shipping."
  });
});


app.get("/api/theme", (_req, res) => {
  res.json({ theme: getSeasonalTheme() });
});


app.get("/kage-basket.js", (_req, res) => {
  res.type("application/javascript");
  res.send(`(function () {
  var box = document.createElement("div");
  box.id = "kage-live-promo";
  box.style.cssText = "margin:12px 16px;padding:12px 14px;border-radius:14px;background:#fff8e8;border:1px solid #e6d3a1;color:#3b2a12;font:600 14px/1.4 sans-serif;";
  function place() {
    if (box.parentNode) return;
    var heading = Array.from(document.querySelectorAll("h1,h2")).find(function (el) {
      return /kage supps/i.test(el.textContent || "");
    });
    var host = heading ? heading.parentNode : document.body;
    if (heading && heading.nextSibling) host.insertBefore(box, heading.nextSibling);
    else host.appendChild(box);
  }
  function money(pence) {
    return "£" + (Number(pence || 0) / 100).toFixed(2);
  }
  function readBasket() {
    var keys = ["basket", "cart", "kage-cart", "kageCart"];
    for (var i = 0; i < keys.length; i++) {
      try {
        var saved = JSON.parse(localStorage.getItem(keys[i]) || "null");
        if (Array.isArray(saved) && saved.length) return saved;
        if (saved && Array.isArray(saved.items)) return saved.items;
      } catch (err) {}
    }
    return [];
  }
  function render(promos, quote) {
    place();
    if (!promos.length) {
      box.textContent = "No promotion is live.";
      return;
    }
    var names = promos.map(function (promo) { return promo.name; }).join(", ");
    var lines = names + " is live. It is taken off before any referral code.";
    if (quote && quote.promotionDiscountPence > 0) {
      lines += " Basket " + money(quote.subtotalPence) + " − " + money(quote.promotionDiscountPence) + " = " + money(quote.totalBeforeCodesPence) + " before referral.";
    } else {
      lines += " Add a qualifying product and the saving shows here before you enter your name or address.";
    }
    box.textContent = lines;
  }
  function refresh() {
    fetch("/api/promotions").then(function (response) { return response.json(); }).then(function (promos) {
      var items = readBasket();
      if (!items.length) return render(promos || [], null);
      return fetch("/api/basket-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: items })
      }).then(function (response) { return response.json(); }).then(function (quote) {
        render(promos || [], quote);
      });
    }).catch(function () {});
  }
  refresh();
  setInterval(refresh, 4000);
})();`);
});

app.get("/kage-spin.js", (_req, res) => {
  res.type("application/javascript");
  res.send(`(function () {
  if (document.getElementById("kage-spin-logo")) return;
  var sources = ["/logo.png", "/logo.jpg", "/logo.webp", "/kage.png", "/icon.png", "/favicon.ico"];
  var img = new Image();
  var index = 0;
  function heading() {
    return Array.from(document.querySelectorAll("h1,h2,.brand,.title")).find(function (el) {
      return /kage supps/i.test(el.textContent || "");
    }) || null;
  }
  function mount(src) {
    var title = heading();
    if (title) {
      title.childNodes.forEach(function (node) {
        if (node.nodeType === 3 && node.textContent.indexOf("⚡") !== -1) {
          node.textContent = node.textContent.replace(/⚡/g, "");
        }
      });
      Array.from(title.querySelectorAll("span,i,em")).forEach(function (el) {
        if ((el.textContent || "").indexOf("⚡") !== -1) el.remove();
      });
    }
    var badge = document.createElement("span");
    badge.id = "kage-spin-logo";
    badge.style.cssText = "display:inline-flex;width:42px;height:42px;margin-left:8px;border-radius:50%;overflow:visible;vertical-align:middle;background:transparent;perspective:200px;";
    var el = document.createElement(src ? "img" : "span");
    if (src) {
      el.src = src;
      el.alt = "Kage Supps";
      el.style.cssText = "width:100%;height:100%;object-fit:cover;"; el.style.animation = "kageSpin 2.8s linear infinite"; el.style.transformStyle = "preserve-3d"; el.style.backfaceVisibility = "visible";
    } else {
      el.textContent = "K";
      el.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#b8860b;font:700 16px sans-serif;"; el.style.animation = "kageSpin 2.8s linear infinite"; el.style.transformStyle = "preserve-3d"; el.style.backfaceVisibility = "visible";
    }
    badge.appendChild(el);
    var style = document.createElement("style");
    style.textContent = "@keyframes kageSpin{from{transform:rotateY(0deg)}to{transform:rotateY(360deg)}}";
    document.head.appendChild(style);
    if (title) title.appendChild(badge);
    else {
      badge.style.position = "fixed";
      badge.style.top = "64px";
      badge.style.right = "16px";
      badge.style.zIndex = "99999";
      document.body.appendChild(badge);
    }
  }
  function tryNext() {
    if (index >= sources.length) return mount("");
    var src = sources[index++];
    img.onload = function () { mount(src); };
    img.onerror = tryNext;
    img.src = src;
  }
  function begin() {
    if (heading() || document.body) tryNext();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", begin);
  else begin();
  fetch("/api/theme").then(function (response) { return response.json(); }).then(function (data) {
    if (!data || !data.theme || data.theme.id !== "halloween") return;
    var style = document.createElement("style");
    style.textContent = "body{animation:kageHalloween 8s linear infinite}@keyframes kageHalloween{0%{filter:hue-rotate(0deg)}50%{filter:hue-rotate(35deg)}100%{filter:hue-rotate(0deg)}}";
    document.head.appendChild(style);
  }).catch(function () {});
})();`);
});

app.use((req, res, next) => {
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  const isPage = req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"));
  if (!acceptsHtml || !isPage) return next();

  const filePath = req.path === "/"
    ? path.join(__dirname, "public", "index.html")
    : path.join(__dirname, "public", req.path);

  try {
    let html = readFileSync(filePath, "utf8");
    if (!html.includes("kage-spin.js")) {
      html = html.replace(
        "</body>",
        '<script src="/kage-spin.js"></script><script src="/kage-basket.js"></script></body>'
      );
    }
    res.type("html").send(html);
  } catch {
    next();
  }
});

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================================================
   MEMORY
   ========================================================= */

const orders = new Map();
const discountCodes = new Map();
const referralEarnings = new Map();

let nextOrderId = 1001;

/* =========================================================
   LOAD SAVED DATA
   ========================================================= */

for (
  const row of db
    .prepare("SELECT id, json FROM orders")
    .all()
) {
  try {
    orders.set(
      Number(row.id),
      JSON.parse(row.json)
    );
  } catch {}
}

for (
  const row of db
    .prepare("SELECT code, json FROM discount_codes")
    .all()
) {
  try {
    discountCodes.set(
      String(row.code).toUpperCase(),
      JSON.parse(row.json)
    );
  } catch {}
}

for (
  const row of db
    .prepare("SELECT code, json FROM referral_earnings")
    .all()
) {
  try {
    referralEarnings.set(
      String(row.code).toUpperCase(),
      JSON.parse(row.json)
    );
  } catch {}
}

const savedNextOrderId = db
  .prepare(
    "SELECT value FROM meta WHERE key = ?"
  )
  .get("nextOrderId");

if (savedNextOrderId) {
  nextOrderId =
    Number(savedNextOrderId.value) ||
    1001;
}

/* =========================================================
   HELPERS
   ========================================================= */


function getSeasonalTheme(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const month = parts.find(part => part.type === "month")?.value;
  const day = parts.find(part => part.type === "day")?.value;

  if (month === "10" && day === "31") {
    return {
      id: "halloween",
      label: "Halloween",
      greeting: "🎃 Happy Halloween"
    };
  }

  return null;
}

function money(pence) {
  return `£${(
    Number(pence || 0) / 100
  ).toFixed(2)}`;
}

function normaliseCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normaliseUsername(value) {
  return String(value || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
}

function saveOrder(order) {
  orders.set(
    Number(order.orderId),
    order
  );

  upsertOrderStmt.run(
    Number(order.orderId),
    JSON.stringify(order)
  );
}

function saveNextOrderId(value) {
  nextOrderId = value;

  upsertMetaStmt.run(
    "nextOrderId",
    String(value)
  );
}

function getMetaValue(key, fallback = null) {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(key);

  return row ? row.value : fallback;
}

function setMetaValue(key, value) {
  upsertMetaStmt.run(
    key,
    String(value)
  );
}

function getStorewidePromo() {
  return {
    code: normaliseCode(
      getMetaValue(
        "storewidePromo:code",
        STOREWIDE_PROMO_DEFAULTS.code
      )
    ),
    discountPercent: Number(
      getMetaValue(
        "storewidePromo:discountPercent",
        STOREWIDE_PROMO_DEFAULTS.discountPercent
      )
    ) || STOREWIDE_PROMO_DEFAULTS.discountPercent,
    active: String(
      getMetaValue(
        "storewidePromo:active",
        STOREWIDE_PROMO_DEFAULTS.active ? "true" : "false"
      )
    ) === "true"
  };
}

function isStorewidePromoLive(promo = getStorewidePromo()) {
  return Boolean(
    promo &&
    promo.active
  );
}

function storewideDiscountForSubtotal(subtotalPence, promo = getStorewidePromo()) {
  if (!promo || !isStorewidePromoLive(promo)) return 0;

  const discountPercent = Number(
    promo.discountPercent || 0
  );

  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    return 0;
  }

  const discount = Math.round(
    Number(subtotalPence) *
    (discountPercent / 100)
  );

  return Math.min(
    Number(subtotalPence),
    Math.max(0, discount)
  );
}

function getAffiliateEarningsText() {
  let totalBalancePence = 0;
  let totalEarnedPence = 0;
  let totalPaidOutPence = 0;

  const sections = affiliateCodes.map(affiliate => {
    const record = referralEarnings.get(affiliate.code);
    const balancePence = Number(record?.balancePence || 0);
    const totalEarnedPenceForCode = Number(record?.totalEarnedPence || 0);
    const paidOutPence = Number(record?.paidOutPence || 0);

    totalBalancePence += balancePence;
    totalEarnedPence += totalEarnedPenceForCode;
    totalPaidOutPence += paidOutPence;

    return `👤 ${affiliate.owner}
Code: ${affiliate.code}

Currently owed:
${money(balancePence)}

Lifetime earned:
${money(totalEarnedPenceForCode)}

Paid out:
${money(paidOutPence)}`;
  });

  return `💰 AFFILIATE EARNINGS

${sections.join("\n\n")}

━━━━━━━━━━━━━━

TOTAL CURRENTLY OWED:
${money(totalBalancePence)}

TOTAL AFFILIATE EARNINGS:
${money(totalEarnedPence)}

TOTAL PAID OUT:
${money(totalPaidOutPence)}`;
}

function saveDiscountCode(
  code,
  record
) {
  const clean = normaliseCode(code);

  discountCodes.set(
    clean,
    record
  );

  upsertDiscountStmt.run(
    clean,
    JSON.stringify(record)
  );
}

function saveReferralEarnings(
  code,
  record
) {
  const clean = normaliseCode(code);

  referralEarnings.set(
    clean,
    record
  );

  upsertReferralStmt.run(
    clean,
    JSON.stringify(record)
  );
}

function calculateDiscount(
  subtotalPence,
  record
) {
  if (!record) {
    return 0;
  }

  if (
    record.discountType ===
    "percent"
  ) {
    return Math.min(
      subtotalPence,
      Math.round(
        subtotalPence *
        (
          Number(record.discountValue) /
          100
        )
      )
    );
  }

  return Math.min(
    subtotalPence,
    Number(
      record.discountValue ||
      0
    )
  );
}

function orderBelongsToViewer(
  order,
  viewer
) {
  if (
    viewer.telegramId &&
    order.telegramId &&
    String(viewer.telegramId) ===
      String(order.telegramId)
  ) {
    return true;
  }

  const a = normaliseUsername(
    order.telegramUsername
  );

  const b = normaliseUsername(
    viewer.telegramUsername
  );

  return Boolean(
    a &&
    b &&
    a === b
  );
}

function isAdmin(userId) {
  if (
    userId === undefined ||
    userId === null
  ) {
    return false;
  }

  return configuredAdminIds.has(
    String(userId)
  );
}

/* =========================================================
   AFFILIATE CODE SETUP
   Existing earnings are preserved.
   ========================================================= */

for (const affiliate of affiliateCodes) {
  saveDiscountCode(
    affiliate.code,
    {
      code: affiliate.code,
      discountType: "percent",
      discountValue: affiliate.discountPercent ?? AFFILIATE_DISCOUNT_PERCENT,
      referralOwner: affiliate.owner,
      commissionPercent: AFFILIATE_COMMISSION_PERCENT,
      cashOnly: true,
      active: true,
      protected: true
    }
  );

  if (!referralEarnings.has(affiliate.code)) {
    saveReferralEarnings(
      affiliate.code,
      {
        code: affiliate.code,
        owner: affiliate.owner,
        balancePence: 0,
        totalEarnedPence: 0,
        paidOutPence: 0,
        cashOnly: true
      }
    );
  } else {
    const existing = referralEarnings.get(affiliate.code);
    existing.owner = affiliate.owner;
    existing.cashOnly = true;
    existing.balancePence = Number(existing.balancePence || 0);
    existing.totalEarnedPence = Number(existing.totalEarnedPence || 0);
    existing.paidOutPence = Number(existing.paidOutPence || 0);

    saveReferralEarnings(
      affiliate.code,
      existing
    );
  }
}

// Seed the store-wide promo only when no saved value exists.
// Old startsAt/endsAt values can remain in SQLite; they are ignored.
if (getMetaValue("storewidePromo:code") === null) {
  setMetaValue("storewidePromo:code", STOREWIDE_PROMO_DEFAULTS.code);
}
if (getMetaValue("storewidePromo:discountPercent") === null) {
  setMetaValue("storewidePromo:discountPercent", STOREWIDE_PROMO_DEFAULTS.discountPercent);
}
if (getMetaValue("storewidePromo:active") === null) {
  setMetaValue("storewidePromo:active", STOREWIDE_PROMO_DEFAULTS.active);
}

/* =========================================================
   REFERRAL COMMISSION
   ========================================================= */

function creditReferralForOrder(
  order
) {
  if (
    !order ||
    order.referralCredited ||
    !order.discountCode ||
    !order.referralCommissionPence
  ) {
    return;
  }

  const code = normaliseCode(
    order.discountCode
  );

  const record =
    referralEarnings.get(code) ||
    {
      code,
      owner:
        order.referralOwner ||
        null,
      balancePence: 0,
      totalEarnedPence: 0,
      paidOutPence: 0,
      cashOnly: false
    };

  record.owner =
    record.owner ||
    order.referralOwner ||
    null;

  record.balancePence =
    Number(record.balancePence || 0) +
    Number(
      order.referralCommissionPence ||
      0
    );

  record.totalEarnedPence =
    Number(
      record.totalEarnedPence ||
      0
    ) +
    Number(
      order.referralCommissionPence ||
      0
    );

  saveReferralEarnings(
    code,
    record
  );

  order.referralCredited = true;
  saveOrder(order);
}

/* =========================================================
   STOCK RESERVATION + LEGACY DEDUCTION
   ========================================================= */

function reserveStockForOrder(order) {
  if (order.stockReserved || order.stockDeducted) {
    return { ok: true, alreadyDone: true };
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    for (const item of order.items || []) {
      const liveStock = getLiveStock(item.id);

      if (liveStock === null) {
        continue;
      }

      const qty = Number(item.quantity || 0);

      const result = reserveInventoryStmt.run(
        qty,
        Number(item.id),
        qty
      );

      if (Number(result.changes || 0) !== 1) {
        throw new Error(
          `Not enough stock remaining for ${item.name}. Available: ${getLiveStock(item.id) ?? 0}.`
        );
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");

    return {
      ok: false,
      error: err?.message || "Could not reserve stock."
    };
  }

  const now = Date.now();

  order.stockReserved = true;
  order.stockReservationReleased = false;
  order.stockReservedAt = new Date(now).toISOString();
  order.reservationExpiresAt = new Date(
    now + STOCK_RESERVATION_MS
  ).toISOString();

  return { ok: true };
}

function restoreReservedStock(order) {
  if (!order?.stockReserved || order.stockReservationReleased) {
    return { ok: true, alreadyDone: true };
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    for (const item of order.items || []) {
      const liveStock = getLiveStock(item.id);

      if (liveStock === null) {
        continue;
      }

      restoreInventoryStmt.run(
        Number(item.quantity || 0),
        Number(item.id)
      );
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  order.stockReserved = false;
  order.stockReservationReleased = true;
  order.stockReleasedAt = new Date().toISOString();

  return { ok: true };
}

function restoreStoreCreditForOrder(order) {
  if (
    !order ||
    order.storeCreditRestored ||
    !order.storeCreditCode ||
    Number(order.storeCreditPence || 0) <= 0
  ) {
    return;
  }

  const code = normaliseCode(order.storeCreditCode);
  const record = referralEarnings.get(code);

  if (!record || record.cashOnly === true) {
    return;
  }

  record.balancePence =
    Number(record.balancePence || 0) +
    Number(order.storeCreditPence || 0);

  saveReferralEarnings(code, record);

  order.storeCreditRestored = true;
  order.storeCreditRestoredAt = new Date().toISOString();
}

function reservationHasExpired(order) {
  if (!order?.reservationExpiresAt) {
    return false;
  }

  const expires = new Date(order.reservationExpiresAt).getTime();

  return Number.isFinite(expires) && Date.now() >= expires;
}

function expireOrderReservation(order) {
  if (
    !order ||
    order.paymentStatus !== "awaiting_payment" ||
    !order.stockReserved ||
    !reservationHasExpired(order)
  ) {
    return false;
  }

  restoreReservedStock(order);
  restoreStoreCreditForOrder(order);

  order.paymentStatus = "cancelled";
  order.fulfilmentStatus = "cancelled";
  order.cancelledAt = new Date().toISOString();
  order.cancellationReason =
    `Payment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes.`;

  saveOrder(order);

  return true;
}

function expireOldReservations() {
  const expired = [];

  for (const order of orders.values()) {
    if (expireOrderReservation(order)) {
      expired.push(order);
    }
  }

  return expired;
}

function deductStockForOrder(order) {
  if (order.stockDeducted) {
    return { ok: true, alreadyDone: true };
  }

  db.exec("BEGIN IMMEDIATE");

  try {
    for (const item of order.items || []) {
      const liveStock = getLiveStock(item.id);

      if (liveStock === null) {
        continue;
      }

      const qty = Number(item.quantity || 0);
      const result = reserveInventoryStmt.run(
        qty,
        Number(item.id),
        qty
      );

      if (Number(result.changes || 0) !== 1) {
        throw new Error(
          `Not enough stock remaining for ${item.name}. Available: ${getLiveStock(item.id) ?? 0}.`
        );
      }
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");

    return {
      ok: false,
      error: err?.message || "Could not deduct stock."
    };
  }

  order.stockDeducted = true;
  order.stockDeductedAt = new Date().toISOString();

  saveOrder(order);

  return { ok: true };
}

/* =========================================================
   USDT QUOTE
   ========================================================= */

async function getUsdtQuote(
  totalPence
) {
  try {
    const response =
      await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=gbp"
      );

    if (!response.ok) {
      throw new Error(
        `CoinGecko HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const gbpPerUsdt =
      Number(
        data?.tether?.gbp
      );

    if (
      !Number.isFinite(gbpPerUsdt) ||
      gbpPerUsdt <= 0
    ) {
      throw new Error(
        "Invalid GBP/USDT rate"
      );
    }

    const pounds =
      Number(totalPence) /
      100;

    return (
      pounds /
      gbpPerUsdt
    ).toFixed(2);
  } catch (err) {
    console.error(
      "USDT QUOTE ERROR:",
      err?.message || err
    );

    return null;
  }
}

/* =========================================================
   TELEGRAM
   ========================================================= */

let bot = null;

if (token) {
  try {
    bot =
      new TelegramBot(
        token,
        {
          polling: true
        }
      );

    bot.on(
      "polling_error",
      err => {
        console.error(
          "TELEGRAM POLLING ERROR:",
          err?.response?.body ||
          err?.message ||
          err
        );
      }
    );

    bot.on(
      "error",
      err => {
        console.error(
          "TELEGRAM ERROR:",
          err?.message ||
          err
        );
      }
    );

    console.log(
      "Telegram bot started."
    );

    bot.setMyCommands([
      { command: "start", description: "Main menu" },
      { command: "admin", description: "Admin dashboard" },
      { command: "order", description: "Find order" },
      { command: "summary", description: "7 day report" },
      { command: "lowstock", description: "Low stock" },
      { command: "reviews", description: "Pending reviews" },
      { command: "earnings", description: "Affiliate earnings" },
      { command: "paid", description: "Mark order paid" },
      { command: "tracking", description: "Add tracking" },
      { command: "myid", description: "Show Telegram ID" }
    ]).catch(err => {
      console.error("SET COMMANDS ERROR:", err?.message || err);
    });
  } catch (err) {
    console.error(
      "Telegram startup failed:",
      err
    );
  }
} else {
  console.warn(
    "Telegram token missing."
  );
}

async function safeSendMessage(
  chatId,
  message,
  options
) {
  if (
    !bot ||
    !chatId
  ) {
    return null;
  }

  try {
    return await bot.sendMessage(
      chatId,
      message,
      options
    );
  } catch (err) {
    console.error(
      "TELEGRAM SEND ERROR:",
      err?.response?.body ||
      err?.message ||
      err
    );

    return null;
  }
}

async function runReservationCleanup() {
  const expired = expireOldReservations();

  for (const order of expired) {
    await safeSendMessage(
      adminTelegramId,
      `⌛ ORDER EXPIRED\n\nOrder: #${order.orderId}\nCustomer: ${order.customerName}\n\nPayment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes.\nReserved stock has been returned to circulation.`
    );

    if (order.telegramId) {
      await safeSendMessage(
        order.telegramId,
        `⌛ Order #${order.orderId} expired because payment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes. The reserved stock has been released.`
      );
    }
  }
}

runReservationCleanup().catch(err =>
  console.error("RESERVATION CLEANUP ERROR:", err)
);

const reservationCleanupTimer = setInterval(() => {
  runReservationCleanup().catch(err =>
    console.error("RESERVATION CLEANUP ERROR:", err)
  );
}, 60 * 1000);

reservationCleanupTimer.unref?.();

/* =========================================================
   REVIEW URL
   ========================================================= */

function getReviewUrl(order) {
  if (
    !webAppUrl ||
    !order.reviewToken
  ) {
    return null;
  }

  const base =
    webAppUrl.replace(
      /\/+$/,
      ""
    );

  return (
    `${base}/review/${order.orderId}` +
    `?token=${encodeURIComponent(
      order.reviewToken
    )}`
  );
}

/* =========================================================
   MARK ORDER PAID
   ========================================================= */

async function markOrderPaid(
  order
) {
  if (
    order.paymentStatus ===
    "paid"
  ) {
    return {
      ok: true,
      alreadyPaid: true
    };
  }

  if (
    order.paymentStatus ===
    "cancelled"
  ) {
    return {
      ok: false,
      error:
        "This order has been cancelled."
    };
  }

  if (order.stockReserved) {
    order.stockReserved = false;
    order.stockReservationReleased = false;
    order.stockCommitted = true;
    order.stockCommittedAt = new Date().toISOString();
    order.reservationExpiresAt = null;
    order.stockDeducted = true;
    order.stockDeductedAt = order.stockReservedAt || new Date().toISOString();
  } else if (!order.stockDeducted) {
    // Legacy order created before stock reservations were introduced.
    const stockResult = deductStockForOrder(order);

    if (!stockResult.ok) {
      return stockResult;
    }
  }

  order.paymentStatus = "paid";
  order.paidAt =
    new Date().toISOString();

  saveOrder(order);

  if (
    order.referralCommissionPence >
      0 &&
    !order.referralCredited
  ) {
    creditReferralForOrder(order);
  }

  const itemLines =
    order.items
      .map(
        item =>
          `${item.quantity} × ${item.name}`
      )
      .join("\n");

  await safeSendMessage(
    adminTelegramId,

`✅ PAYMENT CONFIRMED

Order:
#${order.orderId}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(
        order.telegramUsername
      )}`
    : "Not supplied"
}

📍 DELIVERY ADDRESS:
${order.address}

Items:
${itemLines}

Basket:
${money(order.subtotalPence)}

Discount:
-${money(order.discountPence)}

Promotions:
-${money(order.promotionDiscountPence)}

Store credit:
-${money(order.storeCreditPence)}

Shipping:
${money(order.shippingPence)}

TOTAL:
${money(order.totalPence)}

Transaction:
${
  order.transactionId ||
  "Marked paid manually"
}

Stock updated:
✅`
  );

  if (order.telegramId) {
    const reviewUrl =
      getReviewUrl(order);

    const options =
      reviewUrl
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Leave a Review",
                    url:
                      reviewUrl
                  }
                ]
              ]
            }
          }
        : undefined;

    await safeSendMessage(
      order.telegramId,

`✅ Payment confirmed

Order:
#${order.orderId}

Total:
${money(order.totalPence)}

Your order is now being processed.

Thank you for your order. ⭐`,

      options
    );
  }

  return {
    ok: true
  };
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      products:
        products.length,
      minimumOrderPence:
        MINIMUM_ORDER_PENCE,
      shippingPence:
        SHIPPING_PENCE,
      y8Loaded:
        discountCodes.has("Y8"),
      y8Owner:
        affiliateCodes.find(code => code.code === "Y8")?.owner || null,
      telegramConfigured:
        Boolean(token),
      receivingAddressConfigured:
        Boolean(receivingAddress),
      etherscanConfigured:
        Boolean(etherscanApiKey)
    });
  }
);

/* =========================================================
   CART EVENTS
   ========================================================= */

app.post(
  "/api/cart-events",
  (req, res) => {
    const productId =
      Number(
        req.body?.productId
      );

    const action =
      req.body?.action;

    if (
      !productsById.has(productId) ||
      !["add", "remove"].includes(
        action
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid cart event"
        });
    }

    insertCartEventStmt.run(
      productId,
      action,
      new Date().toISOString()
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   DISCOUNT LOOKUP
   ========================================================= */

app.get(
  "/api/discount-codes/:code",
  (req, res) => {
    const code =
      normaliseCode(
        req.params.code
      );

    const record =
      discountCodes.get(code);

    if (
      !record ||
      record.active === false
    ) {
      return res
        .status(404)
        .json({
          valid: false,
          error:
            "That code isn't valid."
        });
    }

    return res.json({
      valid: true,
      code,
      discountType:
        record.discountType,
      discountValue:
        record.discountValue
    });
  }
);

/* =========================================================
   STORE-WIDE PROMO LOOKUP
   ========================================================= */

app.get(
  "/api/storewide-promo/:code",
  (req, res) => {
    const submittedCode = normaliseCode(req.params.code);
    const promo = getStorewidePromo();

    if (submittedCode !== promo.code) {
      return res
        .status(404)
        .json({
          valid: false,
          error: "That store promo code isn't valid."
        });
    }

    if (!isStorewidePromoLive(promo)) {
      return res
        .status(400)
        .json({
          valid: false,
          error: "That store promo isn't currently active."
        });
    }

    return res.json({
      valid: true,
      code: promo.code,
      discountPercent: promo.discountPercent,
      active: true,
      stackWithAffiliate: true
    });
  }
);

/* =========================================================
   REFERRAL EARNINGS
   ========================================================= */

app.get(
  "/api/referral-codes/:code/earnings",
  (req, res) => {
    const code =
      normaliseCode(
        req.params.code
      );

    const record =
      referralEarnings.get(code);

    if (!record) {
      return res
        .status(404)
        .json({
          error:
            "Referral code not found."
        });
    }

    return res.json({
      code,
      owner:
        record.owner ||
        null,
      balancePence:
        Number(
          record.balancePence ||
          0
        ),
      totalEarnedPence:
        Number(
          record.totalEarnedPence ||
          0
        ),
      paidOutPence:
        Number(
          record.paidOutPence ||
          0
        )
    });
  }
);

/* =========================================================
   CREATE ORDER
   ========================================================= */

app.post(
  "/api/orders",

  async (
    req,
    res
  ) => {
    try {
      const {
        customerName,
        telegramUsername,
        telegramId,
        address,
        items,
        discountCode,
        storewideCode,
        storeCreditCode
      } =
        req.body || {};

      if (
        !customerName ||
        !address ||
        !Array.isArray(items) ||
        items.length === 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing order details"
          });
      }

      const lineItems = [];
      let subtotalPence = 0;

      for (const rawItem of items) {
        const id =
          Number(rawItem?.id);

        const quantity =
          Number(
            rawItem?.quantity
          );

        const product =
          productsById.get(id);

        if (
          !product ||
          !Number.isInteger(quantity) ||
          quantity <= 0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Invalid item in basket"
            });
        }

        const liveStock =
          getLiveStock(id);

        if (
          liveStock !== null &&
          quantity > liveStock
        ) {
          return res
            .status(400)
            .json({
              error:
                `Not enough stock for ${product.name}. Available: ${liveStock}.`
            });
        }

        const pricePence =
          getEffectivePricePence(
            product,
            promotionsApi.getPriceOverride
          );

        if (
          !Number.isInteger(
            pricePence
          ) ||
          pricePence < 0
        ) {
          return res
            .status(400)
            .json({
              error:
                `${product.name} has an invalid price.`
            });
        }

        const lineTotalPence =
          pricePence *
          quantity;

        subtotalPence +=
          lineTotalPence;

        lineItems.push({
          id:
            Number(product.id),
          name:
            product.name,
          quantity,
          pricePence,
          lineTotalPence
        });
      }

      if (
        subtotalPence <
        MINIMUM_ORDER_PENCE
      ) {
        return res
          .status(400)
          .json({
            error:
              "Minimum basket is £50 before discount and shipping."
          });
      }

      let discountPence = 0;
      let appliedDiscountCode =
        null;
      let referralOwner = null;
      let referralCommissionPence =
        0;

      const submittedAffiliate =
        discountCode
          ? discountCodes.get(normaliseCode(discountCode))
          : null;

      const validAffiliate =
        submittedAffiliate &&
        submittedAffiliate.active !== false
          ? submittedAffiliate
          : null;

      const promosForThisOrder =
        promotionsApi.loadPromotions().filter(promo => {
          if (!promo.active) return false;
          if (validAffiliate && promo.stackWithAffiliate === false) {
            return false;
          }
          return true;
        });

      const promotionResult =
        calculatePromotionDiscount(
          lineItems,
          promosForThisOrder
        );

      const promotionDiscountPence =
        promotionResult.promotionDiscountPence;

      const appliedPromotions =
        promotionResult.applied;

      if (discountCode) {
        const code =
          normaliseCode(
            discountCode
          );

        const record =
          discountCodes.get(code);

        if (
          record &&
          record.active !== false
        ) {
          discountPence =
            calculateDiscount(
              Math.max(
                0,
                subtotalPence - promotionDiscountPence
              ),
              record
            );

          appliedDiscountCode =
            code;

          if (
            record.referralOwner &&
            Number(
              record.commissionPercent
            ) > 0
          ) {
            referralOwner =
              record.referralOwner;

            referralCommissionPence =
              Math.round(
                Math.max(
                  0,
                  subtotalPence - promotionDiscountPence
                ) *
                (
                  Number(
                    record.commissionPercent
                  ) /
                  100
                )
              );
          }
        }
      }

      let storewideDiscountPence = 0;
      let appliedStorewideCode = null;

      if (storewideCode) {
        const promo = getStorewidePromo();
        const code = normaliseCode(storewideCode);

        if (
          code === promo.code &&
          isStorewidePromoLive(promo)
        ) {
          storewideDiscountPence =
            storewideDiscountForSubtotal(
              Math.max(
                0,
                subtotalPence - promotionDiscountPence
              ),
              promo
            );

          appliedStorewideCode = promo.code;
        }
      }

      const totalSavingsPence =
        promotionDiscountPence +
        discountPence +
        storewideDiscountPence;

      let storeCreditPence = 0;
      let appliedCreditCode = null;

      if (storeCreditCode) {
        const code =
          normaliseCode(
            storeCreditCode
          );

        const credit =
          referralEarnings.get(code);

        if (
          credit &&
          credit.cashOnly !== true
        ) {
          const remaining =
            Math.max(
              0,
              subtotalPence -
              promotionDiscountPence -
              discountPence -
              storewideDiscountPence
            );

          storeCreditPence =
            Math.min(
              remaining,
              Number(
                credit.balancePence ||
                0
              )
            );

          if (
            storeCreditPence > 0
          ) {
            appliedCreditCode =
              code;
          }
        }
      }

      const productsAfterDiscount =
        Math.max(
          0,
          subtotalPence -
          promotionDiscountPence -
          discountPence -
          storewideDiscountPence -
          storeCreditPence
        );

      const shippingPence =
        SHIPPING_PENCE;

      const totalPence =
        productsAfterDiscount +
        shippingPence;

      const usdtQuote =
        await getUsdtQuote(
          totalPence
        );

      const orderId =
        nextOrderId;

      saveNextOrderId(
        nextOrderId + 1
      );

      const order = {
        orderId,
        customerName:
          String(
            customerName
          ).trim(),
        telegramUsername:
          telegramUsername ||
          "",
        telegramId:
          telegramId ||
          null,
        address:
          String(
            address
          ).trim(),
        items:
          lineItems,
        subtotalPence,
        discountPence,
        affiliateDiscountPence: discountPence,
        promotionDiscountPence,
        appliedPromotions,
        storewideDiscountPence,
        totalSavingsPence,
        storeCreditPence,
        shippingPence,
        totalPence,
        discountCode:
          appliedDiscountCode,
        storewideCode:
          appliedStorewideCode,
        storeCreditCode:
          appliedCreditCode,
        referralOwner,
        referralCommissionPence,
        referralCredited:
          false,
        stockDeducted:
          false,
        stockReserved:
          false,
        stockReservationReleased:
          false,
        reservationExpiresAt:
          null,
        paymentStatus:
          "awaiting_payment",
        fulfilmentStatus:
          "not_shipped",
        quotedUsdt:
          usdtQuote,
        transactionId:
          null,
        trackingNumber:
          null,
        adminNotes: [],
        reviewToken:
          randomUUID(),
        createdAt:
          new Date().toISOString()
      };

      const reservationResult =
        reserveStockForOrder(order);

      if (!reservationResult.ok) {
        return res
          .status(409)
          .json({
            error:
              reservationResult.error ||
              "One or more products are no longer available."
          });
      }

      if (appliedCreditCode && storeCreditPence > 0) {
        const credit = referralEarnings.get(appliedCreditCode);
        if (credit && credit.cashOnly !== true) {
          credit.balancePence = Math.max(
            0,
            Number(credit.balancePence || 0) - storeCreditPence
          );
          saveReferralEarnings(appliedCreditCode, credit);
        }
      }

      saveOrder(order);

      const itemLines =
        lineItems
          .map(
            item =>
              `${item.quantity} × ${item.name}`
          )
          .join("\n");

      await safeSendMessage(
        adminTelegramId,

`🧾 NEW ORDER

Order:
#${orderId}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(
        order.telegramUsername
      )}`
    : "Not supplied"
}

📍 DELIVERY ADDRESS:
${order.address}

Items:
${itemLines}

Basket:
${money(subtotalPence)}

Affiliate saving:
-${money(discountPence)}

Store promo saving:
-${money(storewideDiscountPence)}

TOTAL SAVINGS:
${money(totalSavingsPence)}

Store credit:
-${money(storeCreditPence)}

Shipping:
${money(shippingPence)}

TOTAL:
${money(totalPence)}

${
  appliedDiscountCode
    ? `Affiliate code: ${appliedDiscountCode}`
    : "Affiliate code: None"
}

${
  appliedStorewideCode
    ? `Store promo: ${appliedStorewideCode}`
    : "Store promo: None"
}

${
  referralCommissionPence
    ? `Referral owner: ${referralOwner}
Commission once paid: ${money(
        referralCommissionPence
      )}`
    : ""
}

Status:
Awaiting payment

Stock reserved for:
${STOCK_RESERVATION_MINUTES} minutes

Reservation expires:
${order.reservationExpiresAt}`
      );

      return res.json({
        ok: true,
        orderId,
        subtotalPence,
        discountPence,
        affiliateDiscountPence: discountPence,
        promotionDiscountPence,
        appliedPromotions,
        storewideDiscountPence,
        totalSavingsPence,
        storeCreditPence,
        shippingPence,
        totalPence,
        status:
          order.paymentStatus,
        reservationExpiresAt:
          order.reservationExpiresAt,
        reservationMinutes:
          STOCK_RESERVATION_MINUTES,

        payment: {
          method: "crypto",
          network: "ERC-20",
          address:
            receivingAddress,
          quote: {
            USDT:
              usdtQuote ||
              "QUOTE_PENDING"
          },
          instructions:
            receivingAddress
              ? (
                  usdtQuote
                    ? `Send ${usdtQuote} USDT using Ethereum ERC-20 only, then submit the transaction hash.`
                    : "Payment quote is temporarily unavailable."
                )
              : "Payment address is not configured."
        }
      });
    } catch (err) {
      console.error(
        "CREATE ORDER ERROR:",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Server error while creating order."
        });
    }
  }
);

/* =========================================================
   ORDER STATUS
   ========================================================= */

app.get(
  "/api/orders/:id",
  (
    req,
    res
  ) => {
    const order =
      orders.get(
        Number(req.params.id)
      );

    if (!order) {
      return res
        .status(404)
        .json({
          error:
            "Order not found"
        });
    }

    return res.json({
      orderId:
        order.orderId,
      paymentStatus:
        order.paymentStatus,
      fulfilmentStatus:
        order.fulfilmentStatus,
      subtotalPence:
        order.subtotalPence,
      discountPence:
        order.discountPence,
      storeCreditPence:
        order.storeCreditPence,
      shippingPence:
        order.shippingPence,
      totalPence:
        order.totalPence,
      quotedUsdt:
        order.quotedUsdt,
      trackingNumber:
        order.trackingNumber ||
        null
    });
  }
);

/* =========================================================
   SUBMIT PAYMENT HASH
   ========================================================= */

app.post(
  "/api/orders/:id/confirm-payment",

  async (
    req,
    res
  ) => {
    const order =
      orders.get(
        Number(req.params.id)
      );

    if (!order) {
      return res
        .status(404)
        .json({
          error:
            "Order not found"
        });
    }

    if (
      order.paymentStatus ===
      "paid"
    ) {
      return res.json({
        ok: true,
        alreadyPaid: true
      });
    }

    if (
      order.paymentStatus ===
      "cancelled"
    ) {
      return res
        .status(400)
        .json({
          error:
            "This order has been cancelled."
        });
    }

    if (
      order.paymentStatus === "awaiting_payment" &&
      reservationHasExpired(order)
    ) {
      expireOrderReservation(order);

      return res
        .status(410)
        .json({
          error:
            "This order expired because payment was not submitted within 30 minutes. The reserved stock has been returned."
        });
    }

    const transactionId =
      String(
        req.body?.transactionId ||
        ""
      ).trim();

    if (
      !/^0x[a-fA-F0-9]{64}$/.test(
        transactionId
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "Enter a valid Ethereum transaction hash."
        });
    }

    const alreadyUsed =
      [...orders.values()]
        .some(
          existing =>
            existing.orderId !==
              order.orderId &&
            existing.transactionId
              ?.toLowerCase() ===
            transactionId.toLowerCase()
        );

    if (alreadyUsed) {
      return res
        .status(400)
        .json({
          error:
            "That transaction has already been used."
        });
    }

    order.transactionId =
      transactionId;

    order.paymentStatus =
      "payment_submitted";

    order.paymentSubmittedAt =
      new Date().toISOString();

    // Once a transaction hash is submitted, keep the stock reserved
    // while the admin verifies payment.
    order.reservationExpiresAt = null;
    order.stockReservationHeldForPayment = true;

    saveOrder(order);

    await safeSendMessage(
      adminTelegramId,

`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

📍 Delivery Address:
${order.address}

Expected total:
${money(order.totalPence)}

Transaction:
${transactionId}

Use:
/paid ${order.orderId}

once payment has been confirmed.`
    );

    return res.json({
      ok: true,
      orderId:
        order.orderId,
      status:
        "payment_submitted",
      message:
        "Payment submitted for confirmation."
    });
  }
);

/* =========================================================
   REVIEWS API
   ========================================================= */

app.get(
  "/api/reviews",
  (_req, res) => {
    const rows =
      db.prepare(`
        SELECT
          id,
          display_name,
          rating,
          review_text,
          created_at
        FROM reviews
        WHERE approved = 1
        ORDER BY id DESC
        LIMIT 100
      `).all();

    return res.json(rows);
  }
);

app.post(
  "/api/reviews",
  (req, res) => {
    const orderId =
      Number(
        req.body?.orderId
      );

    const reviewToken =
      String(
        req.body?.token ||
        ""
      );

    const rating =
      Number(
        req.body?.rating
      );

    const displayName =
      String(
        req.body?.displayName ||
        "Customer"
      )
        .trim()
        .slice(0, 50);

    const reviewText =
      String(
        req.body?.reviewText ||
        ""
      )
        .trim()
        .slice(0, 1000);

    const order =
      orders.get(orderId);

    if (!order) {
      return res
        .status(404)
        .json({
          error:
            "Order not found."
        });
    }

    if (
      order.paymentStatus !==
      "paid"
    ) {
      return res
        .status(403)
        .json({
          error:
            "Reviews can be left after payment is confirmed."
        });
    }

    if (
      !reviewToken ||
      reviewToken !==
        order.reviewToken
    ) {
      return res
        .status(403)
        .json({
          error:
            "Invalid review link."
        });
    }

    if (
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    ) {
      return res
        .status(400)
        .json({
          error:
            "Rating must be between 1 and 5."
        });
    }

    if (!reviewText) {
      return res
        .status(400)
        .json({
          error:
            "Please enter a review."
        });
    }

    db.prepare(`
      INSERT INTO reviews (
        order_id,
        telegram_id,
        display_name,
        rating,
        review_text,
        approved,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 0, ?)

      ON CONFLICT(order_id)
      DO UPDATE SET
        display_name = excluded.display_name,
        rating = excluded.rating,
        review_text = excluded.review_text,
        approved = 0,
        created_at = excluded.created_at
    `).run(
      orderId,
      String(
        order.telegramId ||
        ""
      ),
      displayName,
      rating,
      reviewText,
      new Date().toISOString()
    );

    const savedReview =
      db.prepare(`
        SELECT *
        FROM reviews
        WHERE order_id = ?
      `).get(orderId);

    if (savedReview) {
      safeSendMessage(
        adminTelegramId,

`⭐ NEW REVIEW

Review:
#${savedReview.id}

Order:
#${orderId}

Customer:
${displayName}

Rating:
${rating}/5

Review:
${reviewText}

Waiting for approval.`,

        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "✅ Approve",
                  callback_data:
                    `review_approve_${savedReview.id}`
                },
                {
                  text:
                    "❌ Reject",
                  callback_data:
                    `review_reject_${savedReview.id}`
                }
              ]
            ]
          }
        }
      );
    }

    return res.json({
      ok: true,
      message:
        "Thank you. Your review has been submitted."
    });
  }
);

/* =========================================================
   REVIEW PAGE
   ========================================================= */

app.get(
  "/review/:orderId",

  (
    req,
    res
  ) => {
    const orderId =
      Number(
        req.params.orderId
      );

    const reviewToken =
      String(
        req.query.token ||
        ""
      );

    const order =
      orders.get(orderId);

    if (
      !order ||
      reviewToken !==
        order.reviewToken
    ) {
      return res
        .status(404)
        .send(
          "Review link not found."
        );
    }

    if (
      order.paymentStatus !==
      "paid"
    ) {
      return res
        .status(403)
        .send(
          "Payment must be confirmed before leaving a review."
        );
    }

    const tokenJson =
      JSON.stringify(
        reviewToken
      );

    res.type("html");

    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>
<title>Leave a Review</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 24px;
  font-family: Arial, sans-serif;
  background: #ffffff;
  color: #111111;
}

.card {
  max-width: 520px;
  margin: 30px auto;
  border: 1px solid #d5b04c;
  border-radius: 18px;
  padding: 24px;
}

h1 {
  margin-top: 0;
}

.gold {
  color: #b58b16;
}

label {
  display: block;
  font-weight: 700;
  margin-top: 18px;
  margin-bottom: 8px;
}

input,
select,
textarea {
  width: 100%;
  font-size: 16px;
  padding: 13px;
  border: 1px solid #cccccc;
  border-radius: 10px;
}

textarea {
  min-height: 130px;
  resize: vertical;
}

button {
  width: 100%;
  margin-top: 22px;
  padding: 15px;
  border: 0;
  border-radius: 12px;
  background: #c9a227;
  color: #ffffff;
  font-size: 17px;
  font-weight: 700;
}

#message {
  margin-top: 18px;
  font-weight: 700;
}
</style>
</head>

<body>

<div class="card">

<h1>
  <span class="gold">★</span>
  Leave a Review
</h1>

<p>
Order #${orderId}
</p>

<label>
Name
</label>

<input
  id="name"
  maxlength="50"
  placeholder="Your name"
/>

<label>
Rating
</label>

<select id="rating">
  <option value="5">★★★★★ - 5</option>
  <option value="4">★★★★☆ - 4</option>
  <option value="3">★★★☆☆ - 3</option>
  <option value="2">★★☆☆☆ - 2</option>
  <option value="1">★☆☆☆☆ - 1</option>
</select>

<label>
Review
</label>

<textarea
  id="review"
  maxlength="1000"
  placeholder="Tell us about your experience..."
></textarea>

<button id="submit">
Submit Review
</button>

<div id="message"></div>

</div>

<script>
const orderId = ${orderId};
const token = ${tokenJson};

document
  .getElementById("submit")
  .addEventListener(
    "click",
    async () => {
      const button =
        document.getElementById(
          "submit"
        );

      const message =
        document.getElementById(
          "message"
        );

      button.disabled = true;
      message.textContent =
        "Submitting...";

      try {
        const response =
          await fetch(
            "/api/reviews",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json"
              },
              body:
                JSON.stringify({
                  orderId,
                  token,
                  displayName:
                    document
                      .getElementById(
                        "name"
                      )
                      .value,
                  rating:
                    Number(
                      document
                        .getElementById(
                          "rating"
                        )
                        .value
                    ),
                  reviewText:
                    document
                      .getElementById(
                        "review"
                      )
                      .value
                })
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          throw new Error(
            data.error ||
            "Could not submit review."
          );
        }

        message.textContent =
          "⭐ Thank you. Your review has been submitted.";
      } catch (err) {
        message.textContent =
          err.message;

        button.disabled = false;
      }
    }
  );
</script>

</body>
</html>
    `);
  }
);

/* =========================================================
   TELEGRAM ADMIN + CUSTOMER CONTROLS
   ========================================================= */

const pendingSupport =
  new Set();

const pendingAdminOrderLookup =
  new Set();

const pendingAdminTracking =
  new Map();

const pendingAdminNote =
  new Map();

const pendingStockAdjustment =
  new Map();

const pendingPromotionCreate =
  new Map();

const pendingPromotionEdit =
  new Map();

const pendingPriceChange =
  new Map();

if (bot) {

  function clearAdminInputs(
    chatId
  ) {
    pendingAdminOrderLookup.delete(
      chatId
    );

    pendingAdminTracking.delete(
      chatId
    );

    pendingAdminNote.delete(
      chatId
    );

    pendingStockAdjustment.delete(
      chatId
    );

    pendingPromotionCreate.delete(
      chatId
    );

    pendingPromotionEdit.delete(
      chatId
    );

    pendingPriceChange.delete(
      chatId
    );
  }

  function getOrderStatusText(
    order
  ) {
    if (
      order.paymentStatus ===
        "cancelled" ||
      order.fulfilmentStatus ===
        "cancelled"
    ) {
      return "Cancelled ❌";
    }

    if (
      order.fulfilmentStatus ===
      "shipped"
    ) {
      return "Shipped 📦";
    }

    if (
      order.paymentStatus ===
      "paid"
    ) {
      return "Paid ✅";
    }

    if (
      order.paymentStatus ===
      "payment_submitted"
    ) {
      return "Payment submitted ⏳";
    }

    return "Awaiting payment";
  }

  function getRecentOrders(
    limit = 10
  ) {
    return [
      ...orders.values()
    ]
      .sort(
        (
          a,
          b
        ) =>
          new Date(
            b.createdAt ||
            0
          ) -
          new Date(
            a.createdAt ||
            0
          )
      )
      .slice(0, limit);
  }

  async function sendLongMessage(
    chatId,
    message
  ) {
    const maxLength = 3500;

    if (
      message.length <=
      maxLength
    ) {
      return safeSendMessage(
        chatId,
        message
      );
    }

    const paragraphs =
      message.split("\n\n");

    let chunk = "";

    for (
      const paragraph
      of paragraphs
    ) {
      const next =
        chunk
          ? `${chunk}\n\n${paragraph}`
          : paragraph;

      if (
        next.length >
        maxLength
      ) {
        if (chunk) {
          await safeSendMessage(
            chatId,
            chunk
          );
        }

        chunk = paragraph;
      } else {
        chunk = next;
      }
    }

    if (chunk) {
      await safeSendMessage(
        chatId,
        chunk
      );
    }
  }

  function getAdminDashboardOptions() {
    return {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                "📦 Recent Orders",
              callback_data:
                "admin_recent_orders"
            },
            {
              text:
                "⏳ Payments",
              callback_data:
                "admin_payments"
            }
          ],
          [
            {
              text:
                "🚚 Dispatch Queue",
              callback_data:
                "admin_dispatch"
            },
            {
              text:
                "🔎 Find Order",
              callback_data:
                "admin_find_order"
            }
          ],
          [
            {
              text:
                "📊 Sales Reports",
              callback_data:
                "admin_reports"
            },
            {
              text:
                "📦 Stock Centre",
              callback_data:
                "admin_stock"
            }
          ],
          [
            {
              text:
                "⭐ Reviews",
              callback_data:
                "admin_reviews"
            },
            {
              text:
                "💰 Affiliate Earnings",
              callback_data:
                "admin_earnings"
            }
          ],
          [
            {
              text:
                "🎉 Storewide Promo",
              callback_data:
                "admin_storewide_promo"
            }
          ],
          [
            {
              text: "📋 View Product IDs",
              callback_data: "admin_product_ids"
            }
          ],
          [
            {
              text: "🏷 Promotions Manager",
              callback_data: "admin_promotions"
            },
            {
              text: "💷 Change Price",
              callback_data: "admin_price_change"
            }
          ]
        ]
      }
    };
  }

  async function sendAdminDashboard(
    chatId
  ) {
    clearAdminInputs(chatId);

    const paymentWaiting =
      [...orders.values()]
        .filter(
          order =>
            order.paymentStatus ===
            "payment_submitted"
        )
        .length;

    const dispatchWaiting =
      [...orders.values()]
        .filter(
          order =>
            order.paymentStatus ===
              "paid" &&
            order.fulfilmentStatus !==
              "shipped"
        )
        .length;

    const pendingReviews =
      Number(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM reviews
          WHERE approved = 0
        `).get()?.count ||
        0
      );

    const liveProducts =
      getLiveProducts();

    const lowStockCount =
      liveProducts
        .filter(
          product => {
            const stock =
              Number(
                product.stock
              );

            return (
              Number.isFinite(stock) &&
              stock > 0 &&
              stock <=
                LOW_STOCK_THRESHOLD
            );
          }
        )
        .length;

    const outOfStockCount =
      liveProducts
        .filter(
          product =>
            Number(product.stock) ===
            0
        )
        .length;

    return safeSendMessage(
      chatId,

`🛠 ADMIN DASHBOARD

📦 Orders:
${orders.size}

⏳ Payments waiting:
${paymentWaiting}

🚚 Ready to dispatch:
${dispatchWaiting}

⭐ Reviews waiting:
${pendingReviews}

📉 Low stock:
${lowStockCount}

❌ Out of stock:
${outOfStockCount}

Choose an option below.`,

      getAdminDashboardOptions()
    );
  }

  function getAdminOrderButtons(
    order
  ) {
    const buttons = [];
const cancelled =
      order.paymentStatus ===
      "cancelled";

    if (
      !cancelled &&
      order.paymentStatus !==
      "paid"
    ) {
      buttons.push([
        {
          text:
            "✅ Mark Paid",
          callback_data:
            `admin_paid_${order.orderId}`
        }
      ]);
    }

    if (
      order.paymentStatus ===
        "paid" &&
      order.fulfilmentStatus !==
        "shipped"
    ) {
      buttons.push([
        {
          text:
            "🚚 Add Tracking",
          callback_data:
            `admin_tracking_${order.orderId}`
        }
      ]);
    }

    buttons.push([
      {
        text:
          "📝 Add Note",
        callback_data:
          `admin_note_${order.orderId}`
      }
    ]);

    if (
      order.paymentStatus ===
      "paid"
    ) {
      buttons.push([
        {
          text:
            "⭐ Send Review Link",
          callback_data:
            `admin_review_${order.orderId}`
        }
      ]);
    }

    if (
      order.paymentStatus ===
      "awaiting_payment"
    ) {
      buttons.push([
        {
          text:
            "❌ Cancel Order",
          callback_data:
            `admin_cancel_${order.orderId}`
        }
      ]);
    }

    buttons.push([
      {
        text:
          "⬅️ Admin Dashboard",
        callback_data:
          "admin_dashboard"
      }
    ]);

    return {
      reply_markup: {
        inline_keyboard:
          buttons
      }
    };
  }

  async function showAdminOrder(
    chatId,
    order
  ) {
    const items =
      (order.items || [])
        .map(
          item =>
            `${item.quantity} × ${item.name}`
        )
        .join("\n") ||
      "No items";

    const notes =
      Array.isArray(
        order.adminNotes
      ) &&
      order.adminNotes.length
        ? order.adminNotes
            .map(
              note =>
                `• ${note.text}`
            )
            .join("\n")
        : "None";

    return safeSendMessage(
      chatId,

`📦 ORDER #${order.orderId}

Status:
${getOrderStatusText(order)}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(
        order.telegramUsername
      )}`
    : "Not supplied"
}

📍 Address:
${order.address}

Items:
${items}

Basket:
${money(order.subtotalPence)}

Discount:
-${money(order.discountPence)}

Promotions:
-${money(order.promotionDiscountPence)}

Store credit:
-${money(order.storeCreditPence)}

Shipping:
${money(order.shippingPence)}

TOTAL:
${money(order.totalPence)}

Transaction:
${order.transactionId || "None"}

Tracking:
${order.trackingNumber || "None"}

Admin notes:
${notes}`,

      getAdminOrderButtons(order)
    );
  }

  async function showOrderList(
    chatId,
    title,
    list
  ) {
    if (!list.length) {
      return safeSendMessage(
        chatId,
        `${title}\n\nNothing here.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "⬅️ Admin Dashboard",
                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }

    const buttons =
      list
        .slice(0, 20)
        .map(
          order => [
            {
              text:
                `#${order.orderId} • ${order.customerName} • ${money(order.totalPence)}`,
              callback_data:
                `admin_order_${order.orderId}`
            }
          ]
        );

    buttons.push([
      {
        text:
          "⬅️ Admin Dashboard",
        callback_data:
          "admin_dashboard"
      }
    ]);

    return safeSendMessage(
      chatId,
      `${title}\n\nTap an order to manage it.`,
      {
        reply_markup: {
          inline_keyboard:
            buttons
        }
      }
    );
  }

  async function sendSalesReport(
    chatId,
    days,
    title
  ) {
    const startTime =
      Date.now() -
      (
        days *
        24 *
        60 *
        60 *
        1000
      );

    const selected =
      [...orders.values()]
        .filter(
          order => {
            const created =
              new Date(
                order.createdAt ||
                0
              ).getTime();

            return (
              Number.isFinite(
                created
              ) &&
              created >= startTime
            );
          }
        );

    const paid =
      selected.filter(
        order =>
          order.paymentStatus ===
          "paid"
      );

    let revenuePence = 0;
    let shippingPence = 0;
    let discountsPence = 0;
    let unitsPaid = 0;

    const sales =
      new Map();

    for (const order of paid) {
      revenuePence +=
        Number(
          order.totalPence ||
          0
        );

      shippingPence +=
        Number(
          order.shippingPence ||
          0
        );

      discountsPence +=
        Number(order.discountPence || 0) +
        Number(order.promotionDiscountPence || 0) +
        Number(order.storewideDiscountPence || 0);

      for (
        const item
        of order.items || []
      ) {
        const qty =
          Number(
            item.quantity ||
            0
          );

        unitsPaid += qty;

        const key =
          Number(item.id);

        if (
          !sales.has(key)
        ) {
          sales.set(
            key,
            {
              name:
                item.name,
              units: 0,
              salesPence: 0
            }
          );
        }

        const stat =
          sales.get(key);

        stat.units += qty;

        stat.salesPence +=
          Number(
            item.lineTotalPence ||
            (
              Number(
                item.pricePence ||
                0
              ) *
              qty
            )
          );
      }
    }

    const average =
      paid.length
        ? Math.round(
            revenuePence /
            paid.length
          )
        : 0;

    const productLines =
      [...sales.values()]
        .sort(
          (
            a,
            b
          ) =>
            b.units -
            a.units
        )
        .map(
          product =>
`• ${product.name}
${product.units} sold • ${money(product.salesPence)}`
        )
        .join("\n\n");

    await sendLongMessage(
      chatId,

`📊 ${title}

Orders created:
${selected.length}

Paid orders:
${paid.length}

Revenue:
${money(revenuePence)}

Average paid order:
${money(average)}

Shipping collected:
${money(shippingPence)}

Discounts:
${money(discountsPence)}

Units sold:
${unitsPaid}

PRODUCT SALES

${productLines || "No paid sales in this period."}`
    );
  }

  async function sendPendingReviews(
    chatId
  ) {
    const pending =
      db.prepare(`
        SELECT *
        FROM reviews
        WHERE approved = 0
        ORDER BY id ASC
        LIMIT 20
      `).all();

    if (!pending.length) {
      return safeSendMessage(
        chatId,
        "⭐ Reviews\n\nNo reviews are waiting for approval.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "⬅️ Admin Dashboard",
                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }

    for (
      const review
      of pending
    ) {
      await safeSendMessage(
        chatId,

`⭐ REVIEW #${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

Rating:
${review.rating}/5

Review:
${review.review_text}`,

        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "✅ Approve",
                  callback_data:
                    `review_approve_${review.id}`
                },
                {
                  text:
                    "❌ Reject",
                  callback_data:
                    `review_reject_${review.id}`
                }
              ],
              [
                {
                  text:
                    "⬅️ Admin Dashboard",
                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }
  }

  async function showStockCentre(
    chatId
  ) {
    const live =
      getLiveProducts();

    const low =
      live.filter(
        product => {
          const stock =
            Number(product.stock);

          return (
            Number.isFinite(stock) &&
            stock > 0 &&
            stock <=
              LOW_STOCK_THRESHOLD
          );
        }
      );

    const out =
      live.filter(
        product =>
          Number(product.stock) ===
          0
      );

    return safeSendMessage(
      chatId,

`📦 STOCK CENTRE

Products:
${live.length}

Low stock:
${low.length}

Out of stock:
${out.length}

Choose an option.`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "📋 All Stock",
                callback_data:
                  "admin_stock_all"
              },
              {
                text:
                  "📉 Low Stock",
                callback_data:
                  "admin_stock_low"
              }
            ],
            [
              {
                text:
                  "❌ Out of Stock",
                callback_data:
                  "admin_stock_out"
              },
              {
                text:
                  "✏️ Adjust Stock",
                callback_data:
                  "admin_stock_adjust"
              }
            ],
            [
              {
                text:
                  "⬅️ Admin Dashboard",
                callback_data:
                  "admin_dashboard"
              }
            ]
          ]
        }
      }
    );
  }

  async function sendStockList(
    chatId,
    title,
    list
  ) {
    const lines =
      list
        .map(
          product =>
            `#${product.id} • ${product.name}: ${product.stock}`
        )
        .join("\n");

    await sendLongMessage(
      chatId,
      `${title}\n\n${lines || "Nothing here."}`
    );
  }

  /* =======================================================
     /START
     ======================================================= */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,

    async msg => {
      const buttons = [];

      if (webAppUrl) {
        buttons.push([
          {
            text:
              "🛍 OPEN SHOP — TAP HERE",
            web_app: {
              url:
                webAppUrl
            }
          }
        ]);
      }

      buttons.push([
        {
          text:
            "📦 My Orders",
          callback_data:
            "orders"
        },
        {
          text:
            "💬 Support",
          callback_data:
            "support"
        }
      ]);

      buttons.push([
        {
          text:
            "⭐ Reviews",
          callback_data:
            "reviews"
        },
        {
          text:
            "ℹ️ Info",
          callback_data:
            "info"
        }
      ]);

      if (
        isAdmin(
          msg.from?.id
        )
      ) {
        buttons.push([
          {
            text:
              "🛠 Admin Dashboard",
            callback_data:
              "admin_dashboard"
          }
        ]);
      }

      await safeSendMessage(
        msg.chat.id,

`${getSeasonalTheme() ? getSeasonalTheme().greeting + "\n\n" : ""}⚡️ Welcome

🛍 Open Shop
📦 My Orders
💬 Support
⭐ Reviews
ℹ️ Info${
  isAdmin(msg.from?.id)
    ? "\n🛠 Admin Dashboard"
    : ""
}`,

        {
          reply_markup: {
            inline_keyboard:
              buttons
          }
        }
      );
    }
  );

  /* =======================================================
     /ADMIN
     ======================================================= */

  bot.onText(
    /^\/admin(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      return sendAdminDashboard(
        msg.chat.id
      );
    }
  );

  /* =======================================================
     /MYID
     ======================================================= */

  bot.onText(
    /^\/myid(?:@\w+)?$/i,

    async msg => {
      await safeSendMessage(
        msg.chat.id,
        `Your Telegram ID: ${msg.from.id}`
      );
    }
  );

  /* =======================================================
     /EARNINGS
     ======================================================= */

  bot.onText(
    /^\/earnings(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      return sendLongMessage(
        msg.chat.id,
        getAffiliateEarningsText()
      );
    }
  );

  /* =======================================================
     /PAID
     ======================================================= */

  bot.onText(
    /^\/order(?:@\w+)?(?:\s+#?(\d+))?$/i,

    async (msg, match) => {
      const orderId = Number(match[1]);

      if (!orderId) {
        return safeSendMessage(
          msg.chat.id,
          `🔎 FIND ORDER\n\nSend the order number.\n\nExample:\n/order 1049`
        );
      }

      const order = orders.get(orderId);

      if (!order) {
        return safeSendMessage(
          msg.chat.id,
          `❌ Order #${orderId} not found.`
        );
      }

      if (isAdmin(msg.from?.id)) {
        return showAdminOrder(msg.chat.id, order);
      }

      const viewer = {
        telegramId: msg.from?.id,
        telegramUsername: msg.from?.username
      };

      if (!orderBelongsToViewer(order, viewer)) {
        return safeSendMessage(
          msg.chat.id,
          "That order was not found on this account."
        );
      }

      const items = (order.items || [])
        .map(item => `${item.quantity} × ${item.name}`)
        .join("\n");

      return safeSendMessage(
        msg.chat.id,
        `📦 Order #${order.orderId}\n\n${items}\n\nTotal: ${money(order.totalPence)}\nStatus: ${getOrderStatusText(order)}${order.trackingNumber ? `\nTracking: ${order.trackingNumber}` : ""}`
      );
    }
  );

  bot.onText(
    /^\/paid(?:@\w+)?(?:\s+#?(\d+))?$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      const orderId =
        Number(match[1]);

      if (!orderId) {
        return safeSendMessage(
          msg.chat.id,
          `✅ MARK PAID\n\nSend the order number.\n\nExample:\n/paid 1049`
        );
      }

      const order =
        orders.get(orderId);

      if (!order) {
        return safeSendMessage(
          msg.chat.id,
          `❌ Order #${orderId} not found.`
        );
      }

      const result =
        await markOrderPaid(
          order
        );

      if (!result.ok) {
        return safeSendMessage(
          msg.chat.id,

`❌ Could not mark order paid.

${result.error}`
        );
      }

      if (
        result.alreadyPaid
      ) {
        return safeSendMessage(
          msg.chat.id,

`ℹ️ Order #${orderId} was already paid.

Stock has NOT been deducted again.`
        );
      }

      return safeSendMessage(
        msg.chat.id,

`✅ Order #${orderId} marked paid.

Reserved stock is now committed to the order.`
      );
    }
  );

  /* =======================================================
     /SETSTOCK
     Usage: /setstock PRODUCT_ID NEW_STOCK
     Example: /setstock 123 0
     ======================================================= */

  bot.onText(
    /^\/setstock(?:@\w+)?\s+(\d+)\s+(\d+)$/i,

    async (msg, match) => {
      if (!isAdmin(msg.from?.id)) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      const productId = Number(match[1]);
      const newStock = Number(match[2]);
      const product = productsById.get(productId);

      if (!product) {
        return safeSendMessage(
          msg.chat.id,
          `❌ Product #${productId} not found.`
        );
      }

      if (!Number.isInteger(newStock) || newStock < 0) {
        return safeSendMessage(
          msg.chat.id,
          "Stock must be a whole number of 0 or more."
        );
      }

      const oldStock = getLiveStock(productId);

      setInventoryStmt.run(
        newStock,
        productId
      );

      return safeSendMessage(
        msg.chat.id,
        `✅ STOCK UPDATED\n\n${product.name}\n\nOld stock: ${oldStock}\nNew stock: ${newStock}`
      );
    }
  );

  /* =======================================================
     /TRACKING
     ======================================================= */

  bot.onText(
    /^\/tracking(?:@\w+)?(?:\s+#?(\d+)(?:\s+(.+))?)?$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      const orderId =
        Number(match[1]);

      if (!orderId) {
        return safeSendMessage(
          msg.chat.id,
          `🚚 ADD TRACKING\n\nSend the order number and tracking.\n\nExample:\n/tracking 1049 AB123456789GB`
        );
      }

      const trackingNumber =
        String(
          match[2] || ""
        ).trim();

      if (!trackingNumber) {
        return safeSendMessage(
          msg.chat.id,
          `🚚 ADD TRACKING\n\nOrder #${orderId}\n\nSend the tracking on the same line.\n\nExample:\n/tracking ${orderId} AB123456789GB`
        );
      }

      const order =
        orders.get(orderId);

      if (!order) {
        return safeSendMessage(
          msg.chat.id,
          `❌ Order #${orderId} not found.`
        );
      }

      if (
        order.paymentStatus !==
        "paid"
      ) {
        return safeSendMessage(
          msg.chat.id,
          `❌ Order #${orderId} has not been marked paid.`
        );
      }

      order.trackingNumber =
        trackingNumber;

      order.fulfilmentStatus =
        "shipped";

      order.shippedAt =
        new Date().toISOString();

      saveOrder(order);

      await safeSendMessage(
        msg.chat.id,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${trackingNumber}`
      );

      if (order.telegramId) {
        await safeSendMessage(
          order.telegramId,

`📦 Your order has been dispatched

Order:
#${orderId}

Tracking:
${trackingNumber}`
        );
      }
    }
  );

  /* =======================================================
     /REVIEWS
     ======================================================= */

  bot.onText(
    /^\/lowstock(?:@\w+)?$/i,

    async msg => {
      if (!isAdmin(msg.from?.id)) {
        return safeSendMessage(msg.chat.id, "This command is admin-only.");
      }

      const list = getLiveProducts().filter(product => {
        const stock = Number(product.stock);
        return Number.isFinite(stock) && stock > 0 && stock <= LOW_STOCK_THRESHOLD;
      });

      return sendStockList(msg.chat.id, "📉 LOW STOCK", list);
    }
  );

  bot.onText(
    /^\/reviews(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      return sendPendingReviews(
        msg.chat.id
      );
    }
  );

  /* =======================================================
     /SUMMARY
     ======================================================= */

  bot.onText(
    /^\/summary(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return safeSendMessage(
          msg.chat.id,
          "This command is admin-only."
        );
      }

      const sevenDaysAgo =
        Date.now() -
        (
          7 *
          24 *
          60 *
          60 *
          1000
        );

      const sinceIso =
        new Date(
          sevenDaysAgo
        ).toISOString();

      const recentOrders =
        [...orders.values()]
          .filter(
            order => {
              const created =
                new Date(
                  order.createdAt ||
                  0
                ).getTime();

              return (
                Number.isFinite(
                  created
                ) &&
                created >=
                  sevenDaysAgo
              );
            }
          );

      const paidOrders =
        recentOrders.filter(
          order =>
            order.paymentStatus ===
            "paid"
        );

      let revenuePence = 0;
      let shippingPence = 0;
      let discountsPence = 0;
      let storeCreditPence = 0;
      let unitsOrdered = 0;
      let unitsPaid = 0;

      const productStats =
        new Map();

      function statFor(
        id,
        name
      ) {
        const key =
          Number(id);

        if (
          !productStats.has(key)
        ) {
          productStats.set(
            key,
            {
              name:
                name ||
                `Product ${key}`,
              ordered: 0,
              paid: 0,
              revenuePence: 0,
              basketAdds: 0,
              basketRemoves: 0
            }
          );
        }

        return productStats.get(
          key
        );
      }

      for (
        const order
        of recentOrders
      ) {
        discountsPence +=
          Number(order.discountPence || 0) +
          Number(order.promotionDiscountPence || 0) +
          Number(order.storewideDiscountPence || 0);

        storeCreditPence +=
          Number(
            order.storeCreditPence ||
            0
          );

        for (
          const item
          of order.items || []
        ) {
          const qty =
            Number(
              item.quantity ||
              0
            );

          statFor(
            item.id,
            item.name
          ).ordered += qty;

          unitsOrdered += qty;
        }

        if (
          order.paymentStatus ===
          "paid"
        ) {
          revenuePence +=
            Number(
              order.totalPence ||
              0
            );

          shippingPence +=
            Number(
              order.shippingPence ||
              0
            );

          for (
            const item
            of order.items || []
          ) {
            const qty =
              Number(
                item.quantity ||
                0
              );

            const stat =
              statFor(
                item.id,
                item.name
              );

            stat.paid += qty;

            stat.revenuePence +=
              Number(
                item.lineTotalPence ||
                (
                  Number(
                    item.pricePence ||
                    0
                  ) *
                  qty
                )
              );

            unitsPaid += qty;
          }
        }
      }

      const cartRows =
        db.prepare(`
          SELECT
            productId,
            action,
            COUNT(*) AS count
          FROM cart_events
          WHERE createdAt >= ?
          GROUP BY productId, action
        `).all(sinceIso);

      let basketAdds = 0;
      let basketRemoves = 0;

      for (
        const row
        of cartRows
      ) {
        const product =
          productsById.get(
            Number(row.productId)
          );

        const stat =
          statFor(
            row.productId,
            product?.name
          );

        const count =
          Number(
            row.count ||
            0
          );

        if (
          row.action ===
          "add"
        ) {
          stat.basketAdds +=
            count;

          basketAdds +=
            count;
        } else if (
          row.action ===
          "remove"
        ) {
          stat.basketRemoves +=
            count;

          basketRemoves +=
            count;
        }
      }

      const pendingReviews =
        Number(
          db.prepare(`
            SELECT COUNT(*) AS count
            FROM reviews
            WHERE approved = 0
          `).get()?.count ||
          0
        );

      const approvedReviews =
        Number(
          db.prepare(`
            SELECT COUNT(*) AS count
            FROM reviews
            WHERE approved = 1
          `).get()?.count ||
          0
        );

      const productLines =
        [...productStats.values()]
          .filter(
            p =>
              p.ordered ||
              p.paid ||
              p.basketAdds ||
              p.basketRemoves
          )
          .sort(
            (
              a,
              b
            ) =>
              b.paid -
                a.paid ||
              b.ordered -
                a.ordered
          )
          .map(
            p =>
`• ${p.name}
Ordered: ${p.ordered}
Paid: ${p.paid}
Sales: ${money(p.revenuePence)}
Basket +: ${p.basketAdds}
Basket -: ${p.basketRemoves}`
          )
          .join("\n\n");

      return sendLongMessage(
        msg.chat.id,

`📊 7 DAY SUMMARY

Orders created:
${recentOrders.length}

Paid orders:
${paidOrders.length}

Paid revenue:
${money(revenuePence)}

Shipping collected:
${money(shippingPence)}

Discounts:
${money(discountsPence)}

Store credit used:
${money(storeCreditPence)}

Units ordered:
${unitsOrdered}

Units paid:
${unitsPaid}

Basket adds:
${basketAdds}

Basket removals:
${basketRemoves}

Reviews waiting:
${pendingReviews}

Reviews approved:
${approvedReviews}

PRODUCTS

${productLines || "No activity in the last 7 days."}`
      );
    }
  );

  /* =======================================================
     CALLBACKS
     ======================================================= */

  bot.on(
    "callback_query",

    async q => {
      const chatId =
        q.message?.chat?.id;

      if (!chatId) {
        return;
      }

      const data =
        String(
          q.data ||
          ""
        );

      /* REVIEW APPROVE */

      if (
        data.startsWith(
          "review_approve_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          try {
            await bot.answerCallbackQuery(
              q.id,
              {
                text:
                  "Admin only."
              }
            );
          } catch {}

          return;
        }

        const reviewId =
          Number(
            data.replace(
              "review_approve_",
              ""
            )
          );

        const review =
          db.prepare(
            "SELECT * FROM reviews WHERE id = ?"
          ).get(reviewId);

        if (!review) {
          try {
            await bot.answerCallbackQuery(
              q.id,
              {
                text:
                  "Review not found."
              }
            );
          } catch {}

          return;
        }

        db.prepare(
          "UPDATE reviews SET approved = 1 WHERE id = ?"
        ).run(reviewId);

        try {
          await bot.answerCallbackQuery(
            q.id,
            {
              text:
                "Review approved ✅"
            }
          );
        } catch {}

        try {
          await bot.editMessageText(
`✅ REVIEW APPROVED

Review:
#${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

Rating:
${review.rating}/5

${review.review_text}`,
            {
              chat_id:
                chatId,
              message_id:
                q.message.message_id
            }
          );
        } catch {}

        return;
      }

      /* REVIEW REJECT */

      if (
        data.startsWith(
          "review_reject_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          try {
            await bot.answerCallbackQuery(
              q.id,
              {
                text:
                  "Admin only."
              }
            );
          } catch {}

          return;
        }

        const reviewId =
          Number(
            data.replace(
              "review_reject_",
              ""
            )
          );

        const review =
          db.prepare(
            "SELECT * FROM reviews WHERE id = ?"
          ).get(reviewId);

        if (!review) {
          try {
            await bot.answerCallbackQuery(
              q.id,
              {
                text:
                  "Review not found."
              }
            );
          } catch {}

          return;
        }

        db.prepare(
          "DELETE FROM reviews WHERE id = ?"
        ).run(reviewId);

        try {
          await bot.answerCallbackQuery(
            q.id,
            {
              text:
                "Review rejected ❌"
            }
          );
        } catch {}

        try {
          await bot.editMessageText(
`❌ REVIEW REJECTED

Review:
#${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

The review has been removed.`,
            {
              chat_id:
                chatId,
              message_id:
                q.message.message_id
            }
          );
        } catch {}

        return;
      }

      try {
        await bot.answerCallbackQuery(
          q.id
        );
      } catch {}

      /* ADMIN DASHBOARD */

      if (
        data ===
        "admin_dashboard"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return safeSendMessage(
            chatId,
            "Admin only."
          );
        }

        return sendAdminDashboard(
          chatId
        );
      }

      /* RECENT ORDERS */

      if (
        data ===
        "admin_recent_orders"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return showOrderList(
          chatId,
          "📦 RECENT ORDERS",
          getRecentOrders(15)
        );
      }

      /* PAYMENTS */

      if (
        data ===
        "admin_payments"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getRecentOrders(100)
            .filter(
              order =>
                order.paymentStatus ===
                "payment_submitted"
            );

        return showOrderList(
          chatId,
          "⏳ PAYMENTS TO CHECK",
          list
        );
      }

      /* DISPATCH */

      if (
        data ===
        "admin_dispatch"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getRecentOrders(100)
            .filter(
              order =>
                order.paymentStatus ===
                  "paid" &&
                order.fulfilmentStatus !==
                  "shipped"
            );

        return showOrderList(
          chatId,
          "🚚 DISPATCH QUEUE",
          list
        );
      }

      /* FIND ORDER */

      if (
        data ===
        "admin_find_order"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        clearAdminInputs(chatId);

        pendingAdminOrderLookup.add(
          chatId
        );

        return safeSendMessage(
          chatId,

`🔎 FIND ORDER

Send the order number.

Example:
1030`
        );
      }

      /* SALES REPORT MENU */

      if (
        data ===
        "admin_reports"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return safeSendMessage(
          chatId,

`📊 SALES REPORTS

Choose a period.`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "Today",
                    callback_data:
                      "admin_report_1"
                  },
                  {
                    text:
                      "7 Days",
                    callback_data:
                      "admin_report_7"
                  },
                  {
                    text:
                      "30 Days",
                    callback_data:
                      "admin_report_30"
                  }
                ],
                [
                  {
                    text:
                      "⬅️ Admin Dashboard",
                    callback_data:
                      "admin_dashboard"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data ===
        "admin_report_1"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          1,
          "TODAY / LAST 24 HOURS"
        );
      }

      if (
        data ===
        "admin_report_7"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          7,
          "7 DAY REPORT"
        );
      }

      if (
        data ===
        "admin_report_30"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          30,
          "30 DAY REPORT"
        );
      }


      function promotionMenu() {
        return {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📋 View Product IDs", callback_data: "admin_product_ids" },
                { text: "➕ Create Promotion", callback_data: "admin_promo_create" }
              ],
              [
                { text: "🏷 Active Promotions", callback_data: "admin_promo_list" },
                { text: "✏️ Edit Promotion", callback_data: "admin_promo_edit" }
              ],
              [
                { text: "⏯ Enable / Disable", callback_data: "admin_promo_toggle" },
                { text: "🗑 Delete Promotion", callback_data: "admin_promo_delete" }
              ],
              [
                { text: "💷 Change Price", callback_data: "admin_price_change" },
                { text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }
              ]
            ]
          }
        };
      }

      async function sendPromotionsHome(chatIdToUse) {
        const promos = promotionsApi.loadPromotions();
        const active = promos.filter(promo => promo.active).length;
        return safeSendMessage(
          chatIdToUse,
          `🏷 PROMOTIONS MANAGER\n\nPromotions: ${promos.length}\nActive: ${active}\n\nCreate an offer, pause it, or change a product price. Checkout uses these rules on the server.`,
          promotionMenu()
        );
      }

      if (data === "admin_promotions") {
        if (!isAdmin(q.from?.id)) return;
        return sendPromotionsHome(chatId);
      }

      if (data === "admin_promo_list") {
        if (!isAdmin(q.from?.id)) return;
        const promos = promotionsApi.loadPromotions();
        const body = promos.length
          ? promos.map(promo => formatPromotion(promo, money)).join("\n\n")
          : "No promotions yet.";
        await sendLongMessage(chatId, `🏷 PROMOTIONS\n\n${body}`);
        return safeSendMessage(chatId, "Promotions Manager", promotionMenu());
      }

      if (data === "admin_promo_create") {
        if (!isAdmin(q.from?.id)) return;
        clearAdminInputs(chatId);
        pendingPromotionCreate.set(chatId, { stage: "name" });
        return safeSendMessage(
          chatId,
          `➕ CREATE PROMOTION\n\nSend the promotion name.\n\nExample:\nRT40`
        );
      }

      if (
        data === "admin_promo_edit" ||
        data === "admin_promo_toggle" ||
        data === "admin_promo_delete"
      ) {
        if (!isAdmin(q.from?.id)) return;
        clearAdminInputs(chatId);
        const mode = data === "admin_promo_edit"
          ? "edit"
          : data === "admin_promo_toggle"
            ? "toggle"
            : "delete";
        pendingPromotionEdit.set(chatId, { stage: "id", mode });
        return safeSendMessage(
          chatId,
          `Send the promotion ID.\n\nFind it under Active Promotions.\n\nExample:\n3`
        );
      }

      if (data.startsWith("admin_promo_type_")) {
        if (!isAdmin(q.from?.id)) return;
        const state = pendingPromotionCreate.get(chatId);
        if (!state || state.stage !== "type") return;
        state.type = data.replace("admin_promo_type_", "");
        state.stage = "qty";
        pendingPromotionCreate.set(chatId, state);
        return safeSendMessage(
          chatId,
          state.type === "fixed_bundle"
            ? `How many eligible items are in one bundle?\n\nExample:\n2`
            : `Required quantity.\n\nSend 1 to discount every eligible item.\nSend 2 or more to discount only complete sets.`
        );
      }

      if (data === "admin_promo_stack_yes" || data === "admin_promo_stack_no") {
        if (!isAdmin(q.from?.id)) return;
        const state = pendingPromotionCreate.get(chatId);
        if (!state || state.stage !== "stack") return;
        state.stackWithAffiliate = data === "admin_promo_stack_yes";
        state.stage = "confirm";
        pendingPromotionCreate.set(chatId, state);
        const draft = {
          id: "new",
          name: state.name,
          type: state.type,
          productIds: state.productIds,
          requiredQuantity: state.requiredQuantity,
          discountPercent: state.discountPercent,
          discountPence: state.discountPence,
          bundlePricePence: state.bundlePricePence,
          stackWithAffiliate: state.stackWithAffiliate,
          active: true
        };
        return safeSendMessage(
          chatId,
          `Save this promotion?\n\n${formatPromotion(draft, money)}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Save", callback_data: "admin_promo_save" },
                { text: "Cancel", callback_data: "admin_promotions" }
              ]]
            }
          }
        );
      }

      if (data === "admin_promo_save") {
        if (!isAdmin(q.from?.id)) return;
        const state = pendingPromotionCreate.get(chatId);
        if (!state) {
          return safeSendMessage(chatId, "Nothing to save. Start again from Promotions Manager.");
        }
        const conflicts = findPromotionConflicts(
          promotionsApi.loadPromotions(),
          state.productIds
        );
        if (conflicts.length) {
          pendingPromotionCreate.delete(chatId);
          return safeSendMessage(
            chatId,
            `❌ Not saved. These products are already in an active promotion:\n\n${
              conflicts.map(conflict => `#${conflict.promotionId} ${conflict.name}: ${conflict.productIds.join(", ")}`).join("\n")
            }\n\nPause or edit that promotion first.`
          );
        }
        const id = promotionsApi.savePromotion({
          name: state.name,
          type: state.type,
          productIds: state.productIds,
          requiredQuantity: state.requiredQuantity,
          discountPercent: state.discountPercent || 0,
          discountPence: state.discountPence || 0,
          bundlePricePence: state.bundlePricePence || 0,
          stackWithAffiliate: state.stackWithAffiliate !== false,
          active: true,
          createdAt: new Date().toISOString()
        });
        pendingPromotionCreate.delete(chatId);
        await safeSendMessage(chatId, `✅ Promotion #${id} is live.`);
        return sendPromotionsHome(chatId);
      }

      if (data === "admin_price_change") {
        if (!isAdmin(q.from?.id)) return;
        clearAdminInputs(chatId);
        pendingPriceChange.set(chatId, { stage: "product" });
        return safeSendMessage(
          chatId,
          `💷 CHANGE PRICE\n\nSend the product ID.\n\nThis does not edit products.json. The new price is stored in SQLite and used at checkout.`
        );
      }

      /* PRODUCT ID DIRECTORY — admin-only, read-only */
      if (data === "admin_product_ids") {
        if (!isAdmin(q.from?.id)) return;

        const lines = getLiveProducts()
          .slice()
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map(product => [
            `#${product.id} — ${product.name}`,
            `Category: ${product.category || "Other"}`,
            `Section: ${product.section || "Other"}`,
            `Price: ${money(Number(product.pricePence || 0))}`,
            `Stock: ${product.stock ?? "Not entered"}`
          ].join("\n"));

        await sendLongMessage(
          chatId,
          `📋 PRODUCT ID DIRECTORY\n\n${lines.join("\n\n") || "No products found."}`
        );
        return safeSendMessage(chatId, "Directory complete.", {
          reply_markup: {
            inline_keyboard: [[{
              text: "⬅️ Admin Dashboard",
              callback_data: "admin_dashboard"
            }]]
          }
        });
      }

      /* STOCK */

      if (
        data ===
        "admin_stock"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return showStockCentre(
          chatId
        );
      }

      if (
        data ===
        "admin_stock_all"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendStockList(
          chatId,
          "📋 ALL STOCK",
          getLiveProducts()
        );
      }

      if (
        data ===
        "admin_stock_low"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getLiveProducts()
            .filter(
              product => {
                const stock =
                  Number(
                    product.stock
                  );

                return (
                  Number.isFinite(stock) &&
                  stock > 0 &&
                  stock <=
                    LOW_STOCK_THRESHOLD
                );
              }
            );

        return sendStockList(
          chatId,
          "📉 LOW STOCK",
          list
        );
      }

      if (
        data ===
        "admin_stock_out"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getLiveProducts()
            .filter(
              product =>
                Number(
                  product.stock
                ) === 0
            );

        return sendStockList(
          chatId,
          "❌ OUT OF STOCK",
          list
        );
      }

      if (
        data ===
        "admin_stock_adjust"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        clearAdminInputs(chatId);

        pendingStockAdjustment.set(
          chatId,
          {
            stage:
              "product"
          }
        );

        return safeSendMessage(
          chatId,

`✏️ ADJUST STOCK

Send the product ID.

You can find IDs in:
Stock Centre → All Stock`
        );
      }

      /* REVIEWS */

      if (
        data ===
        "admin_reviews"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendPendingReviews(
          chatId
        );
      }

      /* EARNINGS */

      if (
        data ===
        "admin_earnings"
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendLongMessage(
          chatId,
          getAffiliateEarningsText()
        );
      }

      /* STORE-WIDE PROMO */

      if (
        data ===
        "admin_storewide_promo"
      ) {
        if (!isAdmin(q.from?.id)) return;

        const promo = getStorewidePromo();
        const live = isStorewidePromoLive(promo);

        return safeSendMessage(
          chatId,

`🎉 STORE-WIDE PROMO

Code:
${promo.code}

Discount:
${promo.discountPercent}%

Stacks with affiliate codes:
YES

Status:
${live ? "🟢 ACTIVE" : "🔴 OFF"}

${
  live
    ? "Customers can use the promo code now."
    : "The promo code is currently disabled."
}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: live
                      ? "⏸ Turn Promo Off"
                      : "▶️ Turn Promo On",
                    callback_data:
                      "admin_storewide_toggle"
                  }
                ],
                [
                  {
                    text:
                      "⬅️ Admin Dashboard",
                    callback_data:
                      "admin_dashboard"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data ===
        "admin_storewide_toggle"
      ) {
        if (!isAdmin(q.from?.id)) return;

        const promo = getStorewidePromo();
        const newState = !promo.active;

        setMetaValue(
          "storewidePromo:active",
          newState ? "true" : "false"
        );

        const updated = getStorewidePromo();

        return safeSendMessage(
          chatId,
          updated.active
            ? `✅ ${updated.code} is now LIVE.

Customers can now use the code for ${updated.discountPercent}% off.

It will stay active until you manually turn it off.`
            : `⏸ ${updated.code} has been switched OFF.

Customers can no longer use the store-wide promo code.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "🎉 Promo Settings",
                    callback_data:
                      "admin_storewide_promo"
                  }
                ],
                [
                  {
                    text:
                      "⬅️ Admin Dashboard",
                    callback_data:
                      "admin_dashboard"
                  }
                ]
              ]
            }
          }
        );
      }

      /* OPEN ADMIN ORDER */

      if (
        data.startsWith(
          "admin_order_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_order_",
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ADMIN MARK PAID */

      if (
        data.startsWith(
          "admin_paid_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_paid_",
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        const result =
          await markOrderPaid(
            order
          );

        if (!result.ok) {
          return safeSendMessage(
            chatId,
            `❌ ${result.error}`
          );
        }

        await safeSendMessage(
          chatId,
          result.alreadyPaid
            ? `ℹ️ Order #${orderId} was already paid.`
            : `✅ Order #${orderId} marked paid. Reserved stock committed.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ADMIN TRACKING */

      if (
        data.startsWith(
          "admin_tracking_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_tracking_",
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (
          !order ||
          order.paymentStatus !==
          "paid"
        ) {
          return safeSendMessage(
            chatId,
            "Paid order not found."
          );
        }

        clearAdminInputs(chatId);

        pendingAdminTracking.set(
          chatId,
          orderId
        );

        return safeSendMessage(
          chatId,

`🚚 ADD TRACKING

Order:
#${orderId}

Send the tracking number.`
        );
      }

      /* ADMIN NOTE */

      if (
        data.startsWith(
          "admin_note_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_note_",
              ""
            )
          );

        if (
          !orders.has(orderId)
        ) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        clearAdminInputs(chatId);

        pendingAdminNote.set(
          chatId,
          orderId
        );

        return safeSendMessage(
          chatId,

`📝 ADD ADMIN NOTE

Order:
#${orderId}

Send the note below.`
        );
      }

      /* SEND REVIEW LINK */

      if (
        data.startsWith(
          "admin_review_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_review_",
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (
          !order ||
          order.paymentStatus !==
          "paid"
        ) {
          return safeSendMessage(
            chatId,
            "Paid order not found."
          );
        }

        if (!order.telegramId) {
          return safeSendMessage(
            chatId,
            "This order has no Telegram ID."
          );
        }

        const reviewUrl =
          getReviewUrl(order);

        if (!reviewUrl) {
          return safeSendMessage(
            chatId,
            "Review link could not be generated."
          );
        }

        await safeSendMessage(
          order.telegramId,

`⭐ We'd love your feedback

Order:
#${orderId}

Tap below to leave your review.`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Leave a Review",
                    url:
                      reviewUrl
                  }
                ]
              ]
            }
          }
        );

        return safeSendMessage(
          chatId,
          `✅ Review link sent for order #${orderId}.`
        );
      }

      /* CANCEL ORDER */

      if (
        data.startsWith(
          "admin_cancel_confirm_"
        )
      ) {
        if (!isAdmin(q.from?.id)) return;

        const orderId = Number(
          data.replace("admin_cancel_confirm_", "")
        );
        const order = orders.get(orderId);

        if (!order) {
          return safeSendMessage(chatId, "Order not found.");
        }

        if (order.paymentStatus !== "awaiting_payment") {
          return safeSendMessage(
            chatId,
            "This order can no longer be cancelled from the dashboard."
          );
        }

        restoreReservedStock(order);
        restoreStoreCreditForOrder(order);

        order.paymentStatus = "cancelled";
        order.fulfilmentStatus = "cancelled";
        order.cancelledAt = new Date().toISOString();
        saveOrder(order);

        if (order.telegramId) {
          await safeSendMessage(
            order.telegramId,
            `❌ Order cancelled\n\nOrder:\n#${orderId}\n\nIf you believe this was a mistake, please contact support.`
          );
        }

        await safeSendMessage(chatId, `❌ Order #${orderId} cancelled.`);
        return showAdminOrder(chatId, order);
      }

      if (
        data.startsWith(
          "admin_cancel_"
        )
      ) {
        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_cancel_",
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        if (
          order.paymentStatus !==
          "awaiting_payment"
        ) {
          return safeSendMessage(
            chatId,
            "Only unpaid orders with no submitted payment can be cancelled here."
          );
        }

        return safeSendMessage(
          chatId,

`⚠️ CANCEL ORDER #${orderId}?

This will mark the order as cancelled.`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "❌ Yes, Cancel",
                    callback_data:
                      `admin_cancel_confirm_${orderId}`
                  },
                  {
                    text:
                      "Keep Order",
                    callback_data:
                      `admin_order_${orderId}`
                  }
                ]
              ]
            }
          }
        );
      }


      /* MY ORDERS */

      if (
        data ===
        "orders"
      ) {
        const viewer = {
          telegramId:
            q.from?.id,
          telegramUsername:
            q.from?.username
        };

        const matches =
          [...orders.values()]
            .filter(
              order =>
                orderBelongsToViewer(
                  order,
                  viewer
                )
            )
            .sort(
              (
                a,
                b
              ) =>
                new Date(
                  b.createdAt ||
                  0
                ) -
                new Date(
                  a.createdAt ||
                  0
                )
            )
            .slice(0, 10);

        if (!matches.length) {
          return safeSendMessage(
            chatId,

`📦 My Orders

No orders found yet.`
          );
        }

        const lines =
          matches.map(
            order => {
              const tracking =
                order.trackingNumber
                  ? `\nTracking: ${order.trackingNumber}`
                  : "";

              return (
                `#${order.orderId} — ` +
                `${money(order.totalPence)} — ` +
                `${getOrderStatusText(order)}` +
                tracking
              );
            }
          );

        return safeSendMessage(
          chatId,

`📦 My Orders

${lines.join("\n\n")}`
        );
      }

      /* SUPPORT */

      if (
        data ===
        "support"
      ) {
        if (
          !supportTelegramIds.length
        ) {
          return safeSendMessage(
            chatId,

`💬 Support

Support isn't configured yet.`
          );
        }

        pendingSupport.add(chatId);

        return safeSendMessage(
          chatId,

`💬 Support

Send your message below.`
        );
      }

      /* REVIEWS */

      if (data === "reviews") {
        const rows = db.prepare(`
          SELECT display_name, rating, review_text
          FROM reviews
          WHERE approved = 1
          ORDER BY id DESC
          LIMIT 20
        `).all();

        if (!rows.length) {
          return safeSendMessage(
            chatId,
            "⭐ Reviews\n\nNo approved reviews yet."
          );
        }

        const lines = rows.map(review =>
          `${"⭐".repeat(Math.max(1, Math.min(5, Number(review.rating) || 0)))} ${review.display_name}\n${review.review_text}`
        );

        return sendLongMessage(
          chatId,
          `⭐ REVIEWS\n\n${lines.join("\n\n")}`
        );
      }

      /* INFO */

      if (
        data ===
        "info"
      ) {
        return safeSendMessage(
          chatId,

`ℹ️ Info

Minimum basket:
£50 before discount

Delivery:
£5

Tap Open Shop to launch the Mini App.`
        );
      }
    }
  );

  /* =======================================================
     MESSAGE INPUTS
     ======================================================= */

  bot.on(
    "message",

    async msg => {
      const chatId =
        msg.chat?.id;

      if (
        !chatId ||
        !msg.text ||
        msg.text.startsWith("/")
      ) {
        return;
      }

      const text =
        String(msg.text).trim();


      if (pendingPromotionCreate.has(chatId) && isAdmin(msg.from?.id)) {
        const state = pendingPromotionCreate.get(chatId);

        if (state.stage === "name") {
          state.name = text.slice(0, 80);
          state.stage = "products";
          pendingPromotionCreate.set(chatId, state);
          return safeSendMessage(
            chatId,
            `Product IDs for ${state.name}.\n\nComma separated.\n\nExample:\n301, 302`
          );
        }

        if (state.stage === "products") {
          const productIds = parseProductIds(text);
          const missing = productIds.filter(id => !productsById.has(id));
          if (!productIds.length || missing.length) {
            return safeSendMessage(
              chatId,
              missing.length
                ? `❌ Unknown product IDs: ${missing.join(", ")}`
                : "❌ Send at least one product ID."
            );
          }
          state.productIds = productIds;
          state.stage = "type";
          pendingPromotionCreate.set(chatId, state);
          return safeSendMessage(chatId, "Promotion type?", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "Percentage off", callback_data: "admin_promo_type_percent" }],
                [{ text: "Fixed amount off", callback_data: "admin_promo_type_fixed_amount" }],
                [{ text: "Fixed bundle price", callback_data: "admin_promo_type_fixed_bundle" }]
              ]
            }
          });
        }

        if (state.stage === "qty") {
          const requiredQuantity = Number(text);
          if (!Number.isInteger(requiredQuantity) || requiredQuantity < 1) {
            return safeSendMessage(chatId, "❌ Send a whole number of 1 or more.");
          }
          state.requiredQuantity = requiredQuantity;
          state.stage = "value";
          pendingPromotionCreate.set(chatId, state);
          if (state.type === "percent") {
            return safeSendMessage(chatId, "Discount percent.\n\nExample:\n40");
          }
          if (state.type === "fixed_bundle") {
            return safeSendMessage(chatId, "Bundle price for that quantity.\n\nExample:\n80 or 80.00");
          }
          return safeSendMessage(chatId, "Amount off each eligible unit.\n\nExample:\n10");
        }

        if (state.stage === "value") {
          if (state.type === "percent") {
            const discountPercent = Number(text);
            if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
              return safeSendMessage(chatId, "❌ Send a percent from 1 to 100.");
            }
            state.discountPercent = discountPercent;
          } else {
            const pence = parseMoneyToPence(text);
            if (pence === null || pence < 0) {
              return safeSendMessage(chatId, "❌ Send a price like 80 or 12.50");
            }
            if (state.type === "fixed_bundle") state.bundlePricePence = pence;
            else state.discountPence = pence;
          }
          state.stage = "stack";
          pendingPromotionCreate.set(chatId, state);
          return safeSendMessage(chatId, "Allow affiliate codes to stack with this promotion?", {
            reply_markup: {
              inline_keyboard: [[
                { text: "Yes, stack", callback_data: "admin_promo_stack_yes" },
                { text: "No", callback_data: "admin_promo_stack_no" }
              ]]
            }
          });
        }

        return;
      }

      if (pendingPromotionEdit.has(chatId) && isAdmin(msg.from?.id)) {
        const state = pendingPromotionEdit.get(chatId);

        if (state.stage === "id") {
          const promo = promotionsApi.getPromotion(Number(String(text).replace(/^#/, "")));
          if (!promo) {
            return safeSendMessage(chatId, "❌ Promotion not found. Send the ID, or /admin to cancel.");
          }

          if (state.mode === "toggle") {
            promo.active = !promo.active;
            if (promo.active) {
              const conflicts = findPromotionConflicts(
                promotionsApi.loadPromotions(),
                promo.productIds,
                promo.id
              );
              if (conflicts.length) {
                return safeSendMessage(
                  chatId,
                  `❌ Cannot enable. Overlaps #${conflicts[0].promotionId} ${conflicts[0].name} on IDs ${conflicts[0].productIds.join(", ")}.`
                );
              }
            }
            promotionsApi.savePromotion(promo);
            pendingPromotionEdit.delete(chatId);
            return safeSendMessage(
              chatId,
              promo.active ? `✅ #${promo.id} is ACTIVE.` : `⏸ #${promo.id} is PAUSED.`
            );
          }

          if (state.mode === "delete") {
            promotionsApi.deletePromotion(promo.id);
            pendingPromotionEdit.delete(chatId);
            return safeSendMessage(chatId, `🗑 Promotion #${promo.id} deleted.`);
          }

          state.stage = "field";
          state.id = promo.id;
          pendingPromotionEdit.set(chatId, state);
          return safeSendMessage(
            chatId,
            `${formatPromotion(promo, money)}\n\nWhat should change?\n\nReply with one of:\nname\nproducts\npercent\nqty\nprice\nstack`
          );
        }

        if (state.stage === "field") {
          const field = text.toLowerCase();
          if (!["name", "products", "percent", "qty", "price", "stack"].includes(field)) {
            return safeSendMessage(chatId, "Reply with name, products, percent, qty, price, or stack.");
          }
          state.stage = "value";
          state.field = field;
          pendingPromotionEdit.set(chatId, state);
          return safeSendMessage(chatId, `Send the new ${field}.`);
        }

        if (state.stage === "value") {
          const promo = promotionsApi.getPromotion(state.id);
          if (!promo) {
            pendingPromotionEdit.delete(chatId);
            return safeSendMessage(chatId, "Promotion not found.");
          }

          if (state.field === "name") promo.name = text.slice(0, 80);

          if (state.field === "products") {
            const productIds = parseProductIds(text);
            const missing = productIds.filter(id => !productsById.has(id));
            if (!productIds.length || missing.length) {
              return safeSendMessage(
                chatId,
                missing.length
                  ? `❌ Unknown product IDs: ${missing.join(", ")}`
                  : "❌ Send at least one product ID."
              );
            }
            if (promo.active) {
              const conflicts = findPromotionConflicts(
                promotionsApi.loadPromotions(),
                productIds,
                promo.id
              );
              if (conflicts.length) {
                return safeSendMessage(
                  chatId,
                  `❌ Overlaps #${conflicts[0].promotionId} on IDs ${conflicts[0].productIds.join(", ")}. Pause one of them first.`
                );
              }
            }
            promo.productIds = productIds;
          }

          if (state.field === "percent") {
            const discountPercent = Number(text);
            if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
              return safeSendMessage(chatId, "❌ Send a percent from 1 to 100.");
            }
            promo.discountPercent = discountPercent;
            promo.type = "percent";
          }

          if (state.field === "qty") {
            const requiredQuantity = Number(text);
            if (!Number.isInteger(requiredQuantity) || requiredQuantity < 1) {
              return safeSendMessage(chatId, "❌ Send a whole number of 1 or more.");
            }
            promo.requiredQuantity = requiredQuantity;
          }

          if (state.field === "price") {
            const pence = parseMoneyToPence(text);
            if (pence === null || pence < 0) {
              return safeSendMessage(chatId, "❌ Send a price like 80 or 12.50");
            }
            if (promo.type === "fixed_bundle") promo.bundlePricePence = pence;
            else {
              promo.discountPence = pence;
              if (promo.type !== "fixed_amount") promo.type = "fixed_amount";
            }
          }

          if (state.field === "stack") {
            const answer = text.toLowerCase();
            if (!["yes", "no"].includes(answer)) {
              return safeSendMessage(chatId, "Reply yes or no.");
            }
            promo.stackWithAffiliate = answer === "yes";
          }

          promotionsApi.savePromotion(promo);
          pendingPromotionEdit.delete(chatId);
          return safeSendMessage(chatId, `✅ Promotion #${promo.id} updated.\n\n${formatPromotion(promo, money)}`);
        }

        return;
      }

      if (pendingPriceChange.has(chatId) && isAdmin(msg.from?.id)) {
        const state = pendingPriceChange.get(chatId);

        if (state.stage === "product") {
          const productId = Number(String(text).replace(/^#/, ""));
          const product = productsById.get(productId);
          if (!product) {
            return safeSendMessage(chatId, "❌ Product not found.");
          }
          state.stage = "price";
          state.productId = productId;
          pendingPriceChange.set(chatId, state);
          const current = getEffectivePricePence(product, promotionsApi.getPriceOverride);
          return safeSendMessage(
            chatId,
            `${product.name}\n\nCurrent selling price: ${money(current)}\nCatalogue price: ${money(product.pricePence)}\n\nSend the new price, or the word reset to use products.json again.`
          );
        }

        if (state.stage === "price") {
          const product = productsById.get(state.productId);
          if (text.toLowerCase() === "reset") {
            promotionsApi.clearPriceOverride(state.productId);
            pendingPriceChange.delete(chatId);
            return safeSendMessage(
              chatId,
              `✅ ${product?.name || "Product"} is back to the catalogue price ${money(product?.pricePence || 0)}.`
            );
          }
          const pence = parseMoneyToPence(text);
          if (pence === null) {
            return safeSendMessage(chatId, "❌ Send a price like 24.99, or reset.");
          }
          promotionsApi.setPriceOverride(state.productId, pence);
          pendingPriceChange.delete(chatId);
          return safeSendMessage(
            chatId,
            `✅ Price updated\n\n${product?.name}\nNew price: ${money(pence)}\n\nCheckout will use this price. products.json was not edited.`
          );
        }
      }

      /* ADMIN FIND ORDER */

      if (
        pendingAdminOrderLookup.has(
          chatId
        ) &&
        isAdmin(msg.from?.id)
      ) {
        pendingAdminOrderLookup.delete(
          chatId
        );

        const orderId =
          Number(
            text.replace(
              /^#/,
              ""
            )
          );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "❌ Order not found."
          );
        }

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ADMIN TRACKING INPUT */

      if (
        pendingAdminTracking.has(
          chatId
        ) &&
        isAdmin(msg.from?.id)
      ) {
        const orderId =
          pendingAdminTracking.get(
            chatId
          );

        pendingAdminTracking.delete(
          chatId
        );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        order.trackingNumber =
          text;

        order.fulfilmentStatus =
          "shipped";

        order.shippedAt =
          new Date().toISOString();

        saveOrder(order);

        await safeSendMessage(
          chatId,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${text}`
        );

        if (order.telegramId) {
          await safeSendMessage(
            order.telegramId,

`📦 Your order has been dispatched

Order:
#${orderId}

Tracking:
${text}`
          );
        }

        return;
      }

      /* ADMIN NOTE INPUT */

      if (
        pendingAdminNote.has(
          chatId
        ) &&
        isAdmin(msg.from?.id)
      ) {
        const orderId =
          pendingAdminNote.get(
            chatId
          );

        pendingAdminNote.delete(
          chatId
        );

        const order =
          orders.get(orderId);

        if (!order) {
          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        if (
          !Array.isArray(
            order.adminNotes
          )
        ) {
          order.adminNotes = [];
        }

        order.adminNotes.push({
          text:
            text.slice(
              0,
              1000
            ),
          createdAt:
            new Date().toISOString()
        });

        saveOrder(order);

        await safeSendMessage(
          chatId,
          `✅ Note added to order #${orderId}.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* STOCK ADJUSTMENT */

      if (
        pendingStockAdjustment.has(
          chatId
        ) &&
        isAdmin(msg.from?.id)
      ) {
        const state =
          pendingStockAdjustment.get(
            chatId
          );

        if (
          state.stage ===
          "product"
        ) {
          const productId =
            Number(
              text.replace(
                /^#/,
                ""
              )
            );

          const product =
            productsById.get(
              productId
            );

          if (!product) {
            return safeSendMessage(
              chatId,

`❌ Product not found.

Send a valid product ID or use /admin to start again.`
            );
          }

          state.stage =
            "amount";

          state.productId =
            productId;

          pendingStockAdjustment.set(
            chatId,
            state
          );

          return safeSendMessage(
            chatId,

`✏️ ${product.name}

Current stock:
${getLiveStock(productId)}

Send the NEW total stock number.

Example:
25`
          );
        }

        if (
          state.stage ===
          "amount"
        ) {
          const newStock =
            Number(text);

          if (
            !Number.isInteger(
              newStock
            ) ||
            newStock < 0
          ) {
            return safeSendMessage(
              chatId,

`❌ Send a whole number of 0 or more.

Example:
25`
            );
          }

          const product =
            productsById.get(
              state.productId
            );

          setInventoryStmt.run(
            newStock,
            state.productId
          );

          pendingStockAdjustment.delete(
            chatId
          );

          return safeSendMessage(
            chatId,

`✅ STOCK UPDATED

${product?.name || `Product #${state.productId}`}

New stock:
${newStock}`,

            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "📦 Stock Centre",
                      callback_data:
                        "admin_stock"
                    },
                    {
                      text:
                        "⬅️ Dashboard",
                      callback_data:
                        "admin_dashboard"
                    }
                  ]
                ]
              }
            }
          );
        }
      }

      /* SUPPORT */

      if (
        pendingSupport.has(
          chatId
        )
      ) {
        pendingSupport.delete(
          chatId
        );

        const from =
          msg.from?.username
            ? `@${msg.from.username}`
            : `Telegram ID ${msg.from?.id}`;

        for (
          const supportId
          of supportTelegramIds
        ) {
          await safeSendMessage(
            supportId,

`💬 New Support Message

From:
${from}

Message:
${text}`
          );
        }

        return safeSendMessage(
          chatId,
          "Thanks — your message has been sent."
        );
      }
    }
  );
}

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "SERVER ERROR:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    return res
      .status(500)
      .json({
        error:
          "Internal server error"
      });
  }
);

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  port,
  () => {
    console.log(
      `Storefront running on port ${port}`
    );

    console.log(
      `Products: ${products.length}`
    );

    console.log(
      `Minimum basket: ${money(
        MINIMUM_ORDER_PENCE
      )} before discount`
    );

    console.log(
      `Shipping: ${money(
        SHIPPING_PENCE
      )}`
    );

    console.log(
      `Affiliate discount: ${AFFILIATE_DISCOUNT_PERCENT}%`
    );

    console.log(
      `Affiliate commission: ${AFFILIATE_COMMISSION_PERCENT}%`
    );

    console.log(
      `Affiliate codes: ${affiliateCodes.length}`
    );
  }
);

How come it doesn’t include the promotions manager or the RT40