import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

const token = process.env.TELEGRAM || process.env.TELEGRAM_BOT_TOKEN || "";
const receivingAddress = process.env.ETH_RECEIVING_ADDRESS || "";
const etherscanApiKey = process.env.ETHERSCAN || process.env.ETHERSCAN_API_KEY || "";
const webAppUrl = process.env.WEBAPP_URL || "";

const adminTelegramIds = String(process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

const configuredAdminIds = new Set(adminTelegramIds);
const adminTelegramId = adminTelegramIds[0] || "";

const DATA_DIR = process.env.DATA_DIR || ".";
const supportTelegramIds = (process.env.SUPPORT_TELEGRAM_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const MINIMUM_ORDER_PENCE = 5000;
const SHIPPING_PENCE = 500;
const LOW_STOCK_THRESHOLD = 5;
const STOCK_RESERVATION_MINUTES = 30;
const STOCK_RESERVATION_MS = STOCK_RESERVATION_MINUTES * 60 * 1000;

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

const STOREWIDE_PROMO_DEFAULTS = {
  code: "WEEKEND10",
  discountPercent: 10,
  active: false
};

app.use(express.json({ limit: "1mb" }));
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "kage.sqlite"));

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
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  value INTEGER NOT NULL,
  product_ids TEXT NOT NULL,
  min_quantity INTEGER DEFAULT 1,
  stack_with_referral INTEGER DEFAULT 1,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
`);

const promoColumns = db.prepare("PRAGMA table_info(promotions)").all();
if (!promoColumns.some(column => column.name === "stack_with_referral")) {
  db.exec("ALTER TABLE promotions ADD COLUMN stack_with_referral INTEGER DEFAULT 1");
}

const upsertOrderStmt = db.prepare(`
  INSERT INTO orders (id, json) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET json = excluded.json
`);
const upsertDiscountStmt = db.prepare(`
  INSERT INTO discount_codes (code, json) VALUES (?, ?)
  ON CONFLICT(code) DO UPDATE SET json = excluded.json
`);
const upsertReferralStmt = db.prepare(`
  INSERT INTO referral_earnings (code, json) VALUES (?, ?)
  ON CONFLICT(code) DO UPDATE SET json = excluded.json
`);
const upsertMetaStmt = db.prepare(`
  INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);
const insertCartEventStmt = db.prepare(`
  INSERT INTO cart_events (productId, action, createdAt) VALUES (?, ?, ?)
`);
const insertInventoryStmt = db.prepare(`
  INSERT OR IGNORE INTO inventory (product_id, stock) VALUES (?, ?)
`);
const getInventoryStmt = db.prepare(`
  SELECT stock FROM inventory WHERE product_id = ?
`);
const setInventoryStmt = db.prepare(`
  UPDATE inventory SET stock = ? WHERE product_id = ?
`);
const reserveInventoryStmt = db.prepare(`
  UPDATE inventory SET stock = stock - ?
  WHERE product_id = ? AND stock >= ?
`);
const restoreInventoryStmt = db.prepare(`
  UPDATE inventory SET stock = stock + ? WHERE product_id = ?
`);

let products = [];
try {
  // RT40 Pen is added in public/products.json, not in this file.
  products = JSON.parse(
    readFileSync(path.join(__dirname, "public", "products.json"), "utf8")
  );
  if (!Array.isArray(products)) {
    throw new Error("products.json must contain an array.");
  }
} catch (err) {
  console.error("PRODUCT LOAD ERROR:", err);
  process.exit(1);
}

const productsById = new Map(
  products.map(product => [Number(product.id), product])
);

for (const product of products) {
  const id = Number(product.id);
  const originalStock = Number(product.stock);
  if (!Number.isInteger(id) || !Number.isFinite(originalStock)) continue;
  insertInventoryStmt.run(id, Math.max(0, Math.floor(originalStock)));
}

function getLiveStock(productId) {
  const row = getInventoryStmt.get(Number(productId));
  return row ? Number(row.stock) : null;
}

function getLiveProducts() {
  return products.map(product => {
    const liveStock = getLiveStock(product.id);
    return {
      ...product,
      stock: liveStock !== null ? liveStock : product.stock
    };
  });
}

app.get("/products.json", (_req, res) => res.json(getLiveProducts()));
app.get("/api/products", (_req, res) => res.json(getLiveProducts()));
app.use(express.static(path.join(__dirname, "public")));

const orders = new Map();
const discountCodes = new Map();
const referralEarnings = new Map();
const promotions = new Map();
let nextOrderId = 1001;

for (const row of db.prepare("SELECT id, json FROM orders").all()) {
  try { orders.set(Number(row.id), JSON.parse(row.json)); } catch {}
}
for (const row of db.prepare("SELECT code, json FROM discount_codes").all()) {
  try { discountCodes.set(String(row.code).toUpperCase(), JSON.parse(row.json)); } catch {}
}
for (const row of db.prepare("SELECT code, json FROM referral_earnings").all()) {
  try { referralEarnings.set(String(row.code).toUpperCase(), JSON.parse(row.json)); } catch {}
}
for (const row of db.prepare("SELECT * FROM promotions").all()) {
  try {
    promotions.set(Number(row.id), {
      id: row.id,
      name: row.name,
      type: row.type,
      value: row.value,
      productIds: JSON.parse(row.product_ids),
      minQuantity: row.min_quantity,
      stackWithReferral: row.stack_with_referral !== 0,
      active: Boolean(row.active),
      createdAt: row.created_at
    });
  } catch (err) {
    console.error("Failed to load promotion", row.id, err);
  }
}

const savedNextOrderId = db.prepare("SELECT value FROM meta WHERE key = ?").get("nextOrderId");
if (savedNextOrderId) nextOrderId = Number(savedNextOrderId.value) || 1001;

function money(pence) {
  return `£${(Number(pence || 0) / 100).toFixed(2)}`;
}
function normaliseCode(value) {
  return String(value || "").trim().toUpperCase();
}
function normaliseUsername(value) {
  return String(value || "").replace(/^@/, "").trim().toLowerCase();
}
function saveOrder(order) {
  orders.set(Number(order.orderId), order);
  upsertOrderStmt.run(Number(order.orderId), JSON.stringify(order));
}
function saveNextOrderId(value) {
  nextOrderId = value;
  upsertMetaStmt.run("nextOrderId", String(value));
}
function getMetaValue(key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setMetaValue(key, value) {
  upsertMetaStmt.run(key, String(value));
}
function getStorewidePromo() {
  return {
    code: normaliseCode(getMetaValue("storewidePromo:code", STOREWIDE_PROMO_DEFAULTS.code)),
    discountPercent: Number(getMetaValue("storewidePromo:discountPercent", STOREWIDE_PROMO_DEFAULTS.discountPercent)) || STOREWIDE_PROMO_DEFAULTS.discountPercent,
    active: String(getMetaValue("storewidePromo:active", STOREWIDE_PROMO_DEFAULTS.active ? "true" : "false")) === "true"
  };
}
function isStorewidePromoLive(promo = getStorewidePromo()) {
  return Boolean(promo && promo.active);
}
function storewideDiscountForSubtotal(subtotalPence, promo = getStorewidePromo()) {
  if (!isStorewidePromoLive(promo)) return 0;
  const discountPercent = Number(promo.discountPercent || 0);
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) return 0;
  return Math.min(Number(subtotalPence), Math.max(0, Math.round(Number(subtotalPence) * (discountPercent / 100))));
}
function getAffiliateEarningsText() {
  let totalBalancePence = 0;
  let totalEarnedPence = 0;
  let totalPaidOutPence = 0;
  const sections = affiliateCodes.map(affiliate => {
    const record = referralEarnings.get(affiliate.code);
    const balancePence = Number(record?.balancePence || 0);
    const earned = Number(record?.totalEarnedPence || 0);
    const paid = Number(record?.paidOutPence || 0);
    totalBalancePence += balancePence;
    totalEarnedPence += earned;
    totalPaidOutPence += paid;
    return `👤 ${affiliate.owner}\nCode: ${affiliate.code}\n\nCurrently owed:\n${money(balancePence)}\n\nLifetime earned:\n${money(earned)}\n\nPaid out:\n${money(paid)}`;
  });
  return `💰 AFFILIATE EARNINGS\n\n${sections.join("\n\n")}\n\n━━━━━━━━━━━━━━\n\nTOTAL CURRENTLY OWED:\n${money(totalBalancePence)}\n\nTOTAL AFFILIATE EARNINGS:\n${money(totalEarnedPence)}\n\nTOTAL PAID OUT:\n${money(totalPaidOutPence)}`;
}
function saveDiscountCode(code, record) {
  const clean = normaliseCode(code);
  discountCodes.set(clean, record);
  upsertDiscountStmt.run(clean, JSON.stringify(record));
}
function saveReferralEarnings(code, record) {
  const clean = normaliseCode(code);
  referralEarnings.set(clean, record);
  upsertReferralStmt.run(clean, JSON.stringify(record));
}
function calculateDiscount(subtotalPence, record) {
  if (!record) return 0;
  if (record.discountType === "percent") {
    return Math.min(subtotalPence, Math.round(subtotalPence * (Number(record.discountValue) / 100)));
  }
  return Math.min(subtotalPence, Number(record.discountValue || 0));
}
function orderBelongsToViewer(order, viewer) {
  if (viewer.telegramId && order.telegramId && String(viewer.telegramId) === String(order.telegramId)) return true;
  const a = normaliseUsername(order.telegramUsername);
  const b = normaliseUsername(viewer.telegramUsername);
  return Boolean(a && b && a === b);
}
function isAdmin(userId) {
  return userId !== undefined && userId !== null && configuredAdminIds.has(String(userId));
}

for (const affiliate of affiliateCodes) {
  saveDiscountCode(affiliate.code, {
    code: affiliate.code,
    discountType: "percent",
    discountValue: affiliate.discountPercent ?? AFFILIATE_DISCOUNT_PERCENT,
    referralOwner: affiliate.owner,
    commissionPercent: AFFILIATE_COMMISSION_PERCENT,
    cashOnly: true,
    active: true,
    protected: true
  });
  if (!referralEarnings.has(affiliate.code)) {
    saveReferralEarnings(affiliate.code, {
      code: affiliate.code,
      owner: affiliate.owner,
      balancePence: 0,
      totalEarnedPence: 0,
      paidOutPence: 0,
      cashOnly: true
    });
  } else {
    const existing = referralEarnings.get(affiliate.code);
    existing.owner = affiliate.owner;
    existing.cashOnly = true;
    existing.balancePence = Number(existing.balancePence || 0);
    existing.totalEarnedPence = Number(existing.totalEarnedPence || 0);
    existing.paidOutPence = Number(existing.paidOutPence || 0);
    saveReferralEarnings(affiliate.code, existing);
  }
}

if (getMetaValue("storewidePromo:code") === null) setMetaValue("storewidePromo:code", STOREWIDE_PROMO_DEFAULTS.code);
if (getMetaValue("storewidePromo:discountPercent") === null) setMetaValue("storewidePromo:discountPercent", STOREWIDE_PROMO_DEFAULTS.discountPercent);
if (getMetaValue("storewidePromo:active") === null) setMetaValue("storewidePromo:active", STOREWIDE_PROMO_DEFAULTS.active);

function savePromotion(promo) {
  const stack = promo.stackWithReferral ? 1 : 0;
  if (promo.id) {
    db.prepare(`
      UPDATE promotions
      SET name = ?, type = ?, value = ?, product_ids = ?, min_quantity = ?, stack_with_referral = ?, active = ?
      WHERE id = ?
    `).run(
      promo.name,
      promo.type,
      promo.value,
      JSON.stringify(promo.productIds),
      promo.minQuantity,
      stack,
      promo.active ? 1 : 0,
      promo.id
    );
    promotions.set(promo.id, promo);
    return promo;
  }
  const result = db.prepare(`
    INSERT INTO promotions (name, type, value, product_ids, min_quantity, stack_with_referral, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    promo.name,
    promo.type,
    promo.value,
    JSON.stringify(promo.productIds),
    promo.minQuantity,
    stack,
    new Date().toISOString()
  );
  promo.id = Number(result.lastInsertRowid);
  promo.active = true;
  promotions.set(promo.id, promo);
  return promo;
}

function deletePromotion(id) {
  db.prepare("DELETE FROM promotions WHERE id = ?").run(id);
  promotions.delete(Number(id));
}

function promoTypeLabel(type) {
  if (type === "percent") return "Percentage off";
  if (type === "bundle_price") return "Fixed bundle price";
  return "Fixed amount off";
}

function promoValueLabel(promo) {
  if (promo.type === "percent") return `${promo.value}%`;
  return money(promo.value);
}

function itemDiscountForPromo(item, promo) {
  if (item.quantity < Number(promo.minQuantity || 1)) return 0;
  const itemTotal = item.pricePence * item.quantity;
  if (promo.type === "percent") {
    return Math.min(itemTotal, Math.round(itemTotal * (Number(promo.value) / 100)));
  }
  if (promo.type === "fixed_amount") {
    return Math.min(itemTotal, Number(promo.value || 0));
  }
  const bundleQty = Math.max(1, Number(promo.minQuantity || 1));
  const bundles = Math.floor(item.quantity / bundleQty);
  if (bundles < 1) return 0;
  const bundleUnits = bundles * bundleQty;
  const normal = item.pricePence * bundleUnits;
  const bundled = Number(promo.value || 0) * bundles;
  return Math.min(itemTotal, Math.max(0, normal - bundled));
}

function calculatePromotionDiscount(items) {
  const activePromos = [...promotions.values()].filter(promo => promo.active);
  const chosen = new Map();

  for (const item of items) {
    let best = null;
    for (const promo of activePromos) {
      const eligible = promo.productIds.includes("all") || promo.productIds.includes(Number(item.id));
      if (!eligible) continue;
      const amount = itemDiscountForPromo(item, promo);
      if (amount <= 0) continue;
      if (!best || amount > best.amount) {
        best = { promo, amount };
      }
    }
    if (best) chosen.set(item.id, best);
  }

  let totalDiscountPence = 0;
  const appliedPromotions = [];
  const blockedReferralItemIds = [];
  for (const [itemId, best] of chosen) {
    totalDiscountPence += best.amount;
    appliedPromotions.push(best.promo.name);
    if (!best.promo.stackWithReferral) blockedReferralItemIds.push(itemId);
  }
  return {
    totalDiscountPence,
    appliedPromotions: [...new Set(appliedPromotions)],
    blockedReferralItemIds
  };
}

function creditReferralForOrder(order) {
  if (!order || order.referralCredited || !order.discountCode || !order.referralCommissionPence) return;
  const code = normaliseCode(order.discountCode);
  const record = referralEarnings.get(code) || {
    code,
    owner: order.referralOwner || null,
    balancePence: 0,
    totalEarnedPence: 0,
    paidOutPence: 0,
    cashOnly: false
  };
  record.owner = record.owner || order.referralOwner || null;
  record.balancePence = Number(record.balancePence || 0) + Number(order.referralCommissionPence || 0);
  record.totalEarnedPence = Number(record.totalEarnedPence || 0) + Number(order.referralCommissionPence || 0);
  saveReferralEarnings(code, record);
  order.referralCredited = true;
  saveOrder(order);
}

function reserveStockForOrder(order) {
  if (order.stockReserved || order.stockDeducted) return { ok: true, alreadyDone: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of order.items || []) {
      if (getLiveStock(item.id) === null) continue;
      const qty = Number(item.quantity || 0);
      const result = reserveInventoryStmt.run(qty, Number(item.id), qty);
      if (Number(result.changes || 0) !== 1) {
        throw new Error(`Not enough stock remaining for ${item.name}. Available: ${getLiveStock(item.id) ?? 0}.`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return { ok: false, error: err?.message || "Could not reserve stock." };
  }
  const now = Date.now();
  order.stockReserved = true;
  order.stockReservationReleased = false;
  order.stockReservedAt = new Date(now).toISOString();
  order.reservationExpiresAt = new Date(now + STOCK_RESERVATION_MS).toISOString();
  return { ok: true };
}

function restoreReservedStock(order) {
  if (!order?.stockReserved || order.stockReservationReleased) return { ok: true, alreadyDone: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of order.items || []) {
      if (getLiveStock(item.id) === null) continue;
      restoreInventoryStmt.run(Number(item.quantity || 0), Number(item.id));
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
  if (!order || order.storeCreditRestored || !order.storeCreditCode || Number(order.storeCreditPence || 0) <= 0) return;
  const record = referralEarnings.get(normaliseCode(order.storeCreditCode));
  if (!record || record.cashOnly === true) return;
  record.balancePence = Number(record.balancePence || 0) + Number(order.storeCreditPence || 0);
  saveReferralEarnings(order.storeCreditCode, record);
  order.storeCreditRestored = true;
  order.storeCreditRestoredAt = new Date().toISOString();
}

function reservationHasExpired(order) {
  if (!order?.reservationExpiresAt) return false;
  const expires = new Date(order.reservationExpiresAt).getTime();
  return Number.isFinite(expires) && Date.now() >= expires;
}

function expireOrderReservation(order) {
  if (!order || order.paymentStatus !== "awaiting_payment" || !order.stockReserved || !reservationHasExpired(order)) return false;
  restoreReservedStock(order);
  restoreStoreCreditForOrder(order);
  order.paymentStatus = "cancelled";
  order.fulfilmentStatus = "cancelled";
  order.cancelledAt = new Date().toISOString();
  order.cancellationReason = `Payment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes.`;
  saveOrder(order);
  return true;
}

function expireOldReservations() {
  const expired = [];
  for (const order of orders.values()) {
    if (expireOrderReservation(order)) expired.push(order);
  }
  return expired;
}

function deductStockForOrder(order) {
  if (order.stockDeducted) return { ok: true, alreadyDone: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of order.items || []) {
      if (getLiveStock(item.id) === null) continue;
      const qty = Number(item.quantity || 0);
      const result = reserveInventoryStmt.run(qty, Number(item.id), qty);
      if (Number(result.changes || 0) !== 1) {
        throw new Error(`Not enough stock remaining for ${item.name}. Available: ${getLiveStock(item.id) ?? 0}.`);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    return { ok: false, error: err?.message || "Could not deduct stock." };
  }
  order.stockDeducted = true;
  order.stockDeductedAt = new Date().toISOString();
  saveOrder(order);
  return { ok: true };
}

async function getUsdtQuote(totalPence) {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=gbp");
    if (!response.ok) throw new Error(`CoinGecko HTTP ${response.status}`);
    const data = await response.json();
    const gbpPerUsdt = Number(data?.tether?.gbp);
    if (!Number.isFinite(gbpPerUsdt) || gbpPerUsdt <= 0) throw new Error("Invalid GBP/USDT rate");
    return ((Number(totalPence) / 100) / gbpPerUsdt).toFixed(2);
  } catch (err) {
    console.error("USDT QUOTE ERROR:", err?.message || err);
    return null;
  }
}

let bot = null;
if (token) {
  try {
    bot = new TelegramBot(token, { polling: true });
    bot.on("polling_error", err => console.error("TELEGRAM POLLING ERROR:", err?.response?.body || err?.message || err));
    bot.on("error", err => console.error("TELEGRAM ERROR:", err?.message || err));
    console.log("Telegram bot started.");
  } catch (err) {
    console.error("Telegram startup failed:", err);
  }
} else {
  console.warn("Telegram token missing.");
}

async function safeSendMessage(chatId, message, options) {
  if (!bot || !chatId) return null;
  try {
    return await bot.sendMessage(chatId, message, options);
  } catch (err) {
    console.error("TELEGRAM SEND ERROR:", err?.response?.body || err?.message || err);
    return null;
  }
}

async function runReservationCleanup() {
  for (const order of expireOldReservations()) {
    await safeSendMessage(adminTelegramId, `⌛ ORDER EXPIRED\n\nOrder: #${order.orderId}\nCustomer: ${order.customerName}\n\nPayment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes.\nReserved stock has been returned to circulation.`);
    if (order.telegramId) {
      await safeSendMessage(order.telegramId, `⌛ Order #${order.orderId} expired because payment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes. The reserved stock has been released.`);
    }
  }
}
runReservationCleanup().catch(err => console.error("RESERVATION CLEANUP ERROR:", err));
const reservationCleanupTimer = setInterval(() => {
  runReservationCleanup().catch(err => console.error("RESERVATION CLEANUP ERROR:", err));
}, 60 * 1000);
reservationCleanupTimer.unref?.();

function getReviewUrl(order) {
  if (!webAppUrl || !order.reviewToken) return null;
  return `${webAppUrl.replace(/\/+$/, "")}/review/${order.orderId}?token=${encodeURIComponent(order.reviewToken)}`;
}

async function markOrderPaid(order) {
  if (order.paymentStatus === "paid") return { ok: true, alreadyPaid: true };
  if (order.paymentStatus === "cancelled") return { ok: false, error: "This order has been cancelled." };
  if (order.stockReserved) {
    order.stockReserved = false;
    order.stockReservationReleased = false;
    order.stockCommitted = true;
    order.stockCommittedAt = new Date().toISOString();
    order.reservationExpiresAt = null;
    order.stockDeducted = true;
    order.stockDeductedAt = order.stockReservedAt || new Date().toISOString();
  } else if (!order.stockDeducted) {
    const stockResult = deductStockForOrder(order);
    if (!stockResult.ok) return stockResult;
  }
  order.paymentStatus = "paid";
  order.paidAt = new Date().toISOString();
  saveOrder(order);
  if (order.referralCommissionPence > 0 && !order.referralCredited) creditReferralForOrder(order);
  const itemLines = order.items.map(item => `${item.quantity} × ${item.name}`).join("\n");
  await safeSendMessage(adminTelegramId, `✅ PAYMENT CONFIRMED\n\nOrder:\n#${order.orderId}\n\nCustomer:\n${order.customerName}\n\nTelegram:\n${order.telegramUsername ? `@${normaliseUsername(order.telegramUsername)}` : "Not supplied"}\n\n📍 DELIVERY ADDRESS:\n${order.address}\n\nItems:\n${itemLines}\n\nBasket:\n${money(order.subtotalPence)}\n\nDiscount:\n-${money(order.discountPence)}\n\nStore credit:\n-${money(order.storeCreditPence)}\n\nShipping:\n${money(order.shippingPence)}\n\nTOTAL:\n${money(order.totalPence)}\n\nTransaction:\n${order.transactionId || "Marked paid manually"}\n\nStock updated:\n✅`);
  if (order.telegramId) {
    const reviewUrl = getReviewUrl(order);
    await safeSendMessage(order.telegramId, `✅ Payment confirmed\n\nOrder:\n#${order.orderId}\n\nTotal:\n${money(order.totalPence)}\n\nYour order is now being processed.\n\nThank you for your order. ⭐`, reviewUrl ? { reply_markup: { inline_keyboard: [[{ text: "⭐ Leave a Review", url: reviewUrl }]] } } : undefined);
  }
  return { ok: true };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    products: products.length,
    minimumOrderPence: MINIMUM_ORDER_PENCE,
    shippingPence: SHIPPING_PENCE,
    y8Loaded: discountCodes.has("Y8"),
    y8Owner: "@Y8_JKO",
    bens33: discountCodes.get("BENS33")?.discountValue || null,
    telegramConfigured: Boolean(token),
    receivingAddressConfigured: Boolean(receivingAddress),
    etherscanConfigured: Boolean(etherscanApiKey)
  });
});

app.post("/api/cart-events", (req, res) => {
  const productId = Number(req.body?.productId);
  const action = req.body?.action;
  if (!productsById.has(productId) || !["add", "remove"].includes(action)) {
    return res.status(400).json({ error: "Invalid cart event" });
  }
  insertCartEventStmt.run(productId, action, new Date().toISOString());
  res.json({ ok: true });
});

app.get("/api/discount-codes/:code", (req, res) => {
  const code = normaliseCode(req.params.code);
  const record = discountCodes.get(code);
  if (!record || record.active === false) return res.status(404).json({ valid: false, error: "That code isn't valid." });
  res.json({ valid: true, code, discountType: record.discountType, discountValue: record.discountValue });
});

app.get("/api/storewide-promo/:code", (req, res) => {
  const submittedCode = normaliseCode(req.params.code);
  const promo = getStorewidePromo();
  if (submittedCode !== promo.code) return res.status(404).json({ valid: false, error: "That store promo code isn't valid." });
  if (!isStorewidePromoLive(promo)) return res.status(400).json({ valid: false, error: "That store promo isn't currently active." });
  res.json({ valid: true, code: promo.code, discountPercent: promo.discountPercent, active: true, stackWithAffiliate: true });
});

app.get("/api/admin/promotions", (req, res) => {
  const supplied = String(req.get("x-admin-id") || "");
  if (!isAdmin(supplied) && supplied !== String(process.env.ADMIN_API_TOKEN || "disabled")) {
    return res.status(403).json({ error: "Admin only." });
  }
  res.json([...promotions.values()]);
});

app.get("/api/referral-codes/:code/earnings", (req, res) => {
  const code = normaliseCode(req.params.code);
  const record = referralEarnings.get(code);
  if (!record) return res.status(404).json({ error: "Referral code not found." });
  res.json({
    code,
    owner: record.owner || null,
    balancePence: Number(record.balancePence || 0),
    totalEarnedPence: Number(record.totalEarnedPence || 0),
    paidOutPence: Number(record.paidOutPence || 0)
  });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { customerName, telegramUsername, telegramId, address, items, discountCode, storewideCode, storeCreditCode } = req.body || {};
    if (!customerName || !address || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing order details" });
    }
    const lineItems = [];
    let subtotalPence = 0;
    for (const rawItem of items) {
      const id = Number(rawItem?.id);
      const quantity = Number(rawItem?.quantity);
      const product = productsById.get(id);
      if (!product || !Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ error: "Invalid item in basket" });
      const liveStock = getLiveStock(id);
      if (liveStock !== null && quantity > liveStock) return res.status(400).json({ error: `Not enough stock for ${product.name}. Available: ${liveStock}.` });
      const pricePence = Number(product.pricePence);
      if (!Number.isInteger(pricePence) || pricePence < 0) return res.status(400).json({ error: `${product.name} has an invalid price.` });
      const lineTotalPence = pricePence * quantity;
      subtotalPence += lineTotalPence;
      lineItems.push({ id: Number(product.id), name: product.name, quantity, pricePence, lineTotalPence });
    }
    if (subtotalPence < MINIMUM_ORDER_PENCE) return res.status(400).json({ error: "Minimum basket is £50 before discount and shipping." });

    const promoResult = calculatePromotionDiscount(lineItems);
    const promoDiscountPence = promoResult.totalDiscountPence;
    const blocked = new Set(promoResult.blockedReferralItemIds);
    const affiliateBase = lineItems
      .filter(item => !blocked.has(item.id))
      .reduce((sum, item) => sum + item.lineTotalPence, 0);

    let affiliateDiscountPence = 0;
    let appliedDiscountCode = null;
    let referralOwner = null;
    let referralCommissionPence = 0;
    if (discountCode) {
      const code = normaliseCode(discountCode);
      const record = discountCodes.get(code);
      if (record && record.active !== false) {
        affiliateDiscountPence = calculateDiscount(affiliateBase, record);
        appliedDiscountCode = code;
        if (record.referralOwner && Number(record.commissionPercent) > 0) {
          referralOwner = record.referralOwner;
          referralCommissionPence = Math.round(affiliateBase * (Number(record.commissionPercent) / 100));
        }
      }
    }

    let storewideDiscountPence = 0;
    let appliedStorewideCode = null;
    if (storewideCode) {
      const promo = getStorewidePromo();
      const code = normaliseCode(storewideCode);
      if (code === promo.code && isStorewidePromoLive(promo)) {
        storewideDiscountPence = storewideDiscountForSubtotal(Math.max(0, subtotalPence - promoDiscountPence - affiliateDiscountPence), promo);
        appliedStorewideCode = promo.code;
      }
    }

    const discountPence = promoDiscountPence + affiliateDiscountPence;
    const totalSavingsPence = discountPence + storewideDiscountPence;
    let storeCreditPence = 0;
    let appliedCreditCode = null;
    if (storeCreditCode) {
      const code = normaliseCode(storeCreditCode);
      const credit = referralEarnings.get(code);
      if (credit && credit.cashOnly !== true) {
        const remaining = Math.max(0, subtotalPence - discountPence - storewideDiscountPence);
        storeCreditPence = Math.min(remaining, Number(credit.balancePence || 0));
        if (storeCreditPence > 0) {
          appliedCreditCode = code;
          credit.balancePence = Math.max(0, Number(credit.balancePence || 0) - storeCreditPence);
          saveReferralEarnings(code, credit);
        }
      }
    }
    const productsAfterDiscount = Math.max(0, subtotalPence - discountPence - storewideDiscountPence - storeCreditPence);
    const totalPence = productsAfterDiscount + SHIPPING_PENCE;
    const usdtQuote = await getUsdtQuote(totalPence);
    const orderId = nextOrderId;
    saveNextOrderId(nextOrderId + 1);
    const order = {
      orderId,
      customerName: String(customerName).trim(),
      telegramUsername: telegramUsername || "",
      telegramId: telegramId || null,
      address: String(address).trim(),
      items: lineItems,
      subtotalPence,
      discountPence,
      affiliateDiscountPence,
      promotionDiscountPence: promoDiscountPence,
      automaticPromotions: promoResult.appliedPromotions,
      storewideDiscountPence,
      totalSavingsPence,
      storeCreditPence,
      shippingPence: SHIPPING_PENCE,
      totalPence,
      discountCode: appliedDiscountCode,
      storewideCode: appliedStorewideCode,
      storeCreditCode: appliedCreditCode,
      referralOwner,
      referralCommissionPence,
      referralCredited: false,
      stockDeducted: false,
      stockReserved: false,
      stockReservationReleased: false,
      reservationExpiresAt: null,
      paymentStatus: "awaiting_payment",
      fulfilmentStatus: "not_shipped",
      quotedUsdt: usdtQuote,
      transactionId: null,
      trackingNumber: null,
      adminNotes: [],
      reviewToken: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const reservationResult = reserveStockForOrder(order);
    if (!reservationResult.ok) {
      restoreStoreCreditForOrder(order);
      return res.status(409).json({ error: reservationResult.error || "One or more products are no longer available." });
    }
    saveOrder(order);
    const itemLines = lineItems.map(item => `${item.quantity} × ${item.name}`).join("\n");
    await safeSendMessage(adminTelegramId, `🧾 NEW ORDER\n\nOrder:\n#${orderId}\n\nCustomer:\n${order.customerName}\n\nTelegram:\n${order.telegramUsername ? `@${normaliseUsername(order.telegramUsername)}` : "Not supplied"}\n\n📍 DELIVERY ADDRESS:\n${order.address}\n\nItems:\n${itemLines}\n\nBasket:\n${money(subtotalPence)}\n\nAuto promos:\n-${money(promoDiscountPence)}\n\nAffiliate saving:\n-${money(affiliateDiscountPence)}\n\nStore promo saving:\n-${money(storewideDiscountPence)}\n\nTOTAL SAVINGS:\n${money(totalSavingsPence)}\n\nStore credit:\n-${money(storeCreditPence)}\n\nShipping:\n${money(SHIPPING_PENCE)}\n\nTOTAL:\n${money(totalPence)}\n\n${appliedDiscountCode ? `Affiliate code: ${appliedDiscountCode}` : "Affiliate code: None"}\n${appliedStorewideCode ? `Store promo: ${appliedStorewideCode}` : "Store promo: None"}\n${promoResult.appliedPromotions.length ? `Auto Promos: ${promoResult.appliedPromotions.join(", ")}` : ""}\n${referralCommissionPence ? `Referral owner: ${referralOwner}\nCommission once paid: ${money(referralCommissionPence)}` : ""}\n\nStatus:\nAwaiting payment\n\nStock reserved for:\n${STOCK_RESERVATION_MINUTES} minutes\n\nReservation expires:\n${order.reservationExpiresAt}`);
    return res.json({
      ok: true,
      orderId,
      subtotalPence,
      discountPence,
      affiliateDiscountPence,
      promotionDiscountPence: promoDiscountPence,
      automaticPromotions: promoResult.appliedPromotions,
      storewideDiscountPence,
      totalSavingsPence,
      storeCreditPence,
      shippingPence: SHIPPING_PENCE,
      totalPence,
      status: order.paymentStatus,
      reservationExpiresAt: order.reservationExpiresAt,
      reservationMinutes: STOCK_RESERVATION_MINUTES,
      payment: {
        method: "crypto",
        network: "ERC-20",
        address: receivingAddress,
        quote: { USDT: usdtQuote || "QUOTE_PENDING" },
        instructions: receivingAddress
          ? (usdtQuote ? `Send ${usdtQuote} USDT using Ethereum ERC-20 only, then submit the transaction hash.` : "Payment quote is temporarily unavailable.")
          : "Payment address is not configured."
      }
    });
  } catch (err) {
    console.error("CREATE ORDER ERROR:", err);
    return res.status(500).json({ error: "Server error while creating order." });
  }
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json({
    orderId: order.orderId,
    paymentStatus: order.paymentStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    subtotalPence: order.subtotalPence,
    discountPence: order.discountPence,
    storeCreditPence: order.storeCreditPence,
    shippingPence: order.shippingPence,
    totalPence: order.totalPence,
    quotedUsdt: order.quotedUsdt,
    trackingNumber: order.trackingNumber || null
  });
});

app.post("/api/orders/:id/confirm-payment", async (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.paymentStatus === "paid") return res.json({ ok: true, alreadyPaid: true });
  if (order.paymentStatus === "cancelled") return res.status(400).json({ error: "This order has been cancelled." });
  if (order.paymentStatus === "awaiting_payment" && reservationHasExpired(order)) {
    expireOrderReservation(order);
    return res.status(410).json({ error: "This order expired because payment was not submitted within 30 minutes. The reserved stock has been returned." });
  }
  const transactionId = String(req.body?.transactionId || "").trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionId)) return res.status(400).json({ error: "Enter a valid Ethereum transaction hash." });
  const alreadyUsed = [...orders.values()].some(existing => existing.orderId !== order.orderId && existing.transactionId?.toLowerCase() === transactionId.toLowerCase());
  if (alreadyUsed) return res.status(400).json({ error: "That transaction has already been used." });
  order.transactionId = transactionId;
  order.paymentStatus = "payment_submitted";
  order.paymentSubmittedAt = new Date().toISOString();
  order.reservationExpiresAt = null;
  order.stockReservationHeldForPayment = true;
  saveOrder(order);
  await safeSendMessage(adminTelegramId, `💳 PAYMENT SUBMITTED\n\nOrder:\n#${order.orderId}\n\nCustomer:\n${order.customerName}\n\n📍 Delivery Address:\n${order.address}\n\nExpected total:\n${money(order.totalPence)}\n\nTransaction:\n${transactionId}\n\nUse:\n/paid ${order.orderId}\n\nonce payment has been confirmed.`);
  res.json({ ok: true, orderId: order.orderId, status: "payment_submitted", message: "Payment submitted for confirmation." });
});

app.get("/api/reviews", (_req, res) => {
  res.json(db.prepare(`
    SELECT id, display_name, rating, review_text, created_at
    FROM reviews WHERE approved = 1 ORDER BY id DESC LIMIT 100
  `).all());
});

app.post("/api/reviews", (req, res) => {
  const orderId = Number(req.body?.orderId);
  const reviewToken = String(req.body?.token || "");
  const rating = Number(req.body?.rating);
  const displayName = String(req.body?.displayName || "Customer").trim().slice(0, 50);
  const reviewText = String(req.body?.reviewText || "").trim().slice(0, 1000);
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.paymentStatus !== "paid") return res.status(403).json({ error: "Reviews can be left after payment is confirmed." });
  if (!reviewToken || reviewToken !== order.reviewToken) return res.status(403).json({ error: "Invalid review link." });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be between 1 and 5." });
  if (!reviewText) return res.status(400).json({ error: "Please enter a review." });
  db.prepare(`
    INSERT INTO reviews (order_id, telegram_id, display_name, rating, review_text, approved, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      display_name = excluded.display_name,
      rating = excluded.rating,
      review_text = excluded.review_text,
      approved = 0,
      created_at = excluded.created_at
  `).run(orderId, String(order.telegramId || ""), displayName, rating, reviewText, new Date().toISOString());
  const savedReview = db.prepare("SELECT * FROM reviews WHERE order_id = ?").get(orderId);
  if (savedReview) {
    safeSendMessage(adminTelegramId, `⭐ NEW REVIEW\n\nReview:\n#${savedReview.id}\n\nOrder:\n#${orderId}\n\nCustomer:\n${displayName}\n\nRating:\n${rating}/5\n\nReview:\n${reviewText}\n\nWaiting for approval.`, {
      reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `review_approve_${savedReview.id}` }, { text: "❌ Reject", callback_data: `review_reject_${savedReview.id}` }]] }
    });
  }
  res.json({ ok: true, message: "Thank you. Your review has been submitted." });
});

app.get("/review/:orderId", (req, res) => {
  const orderId = Number(req.params.orderId);
  const reviewToken = String(req.query.token || "");
  const order = orders.get(orderId);
  if (!order || reviewToken !== order.reviewToken) return res.status(404).send("Review link not found.");
  if (order.paymentStatus !== "paid") return res.status(403).send("Payment must be confirmed before leaving a review.");
  res.type("html").send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Leave a Review</title></head><body style="font-family:Arial;padding:24px"><h1>Leave a Review</h1><p>Order #${orderId}</p><input id="name" maxlength="50" placeholder="Your name"><br><select id="rating"><option value="5">5</option><option value="4">4</option><option value="3">3</option><option value="2">2</option><option value="1">1</option></select><br><textarea id="review" maxlength="1000"></textarea><br><button id="submit">Submit Review</button><div id="message"></div><script>const orderId=${orderId};const token=${JSON.stringify(reviewToken)};document.getElementById("submit").onclick=async()=>{const message=document.getElementById("message");message.textContent="Submitting...";const response=await fetch("/api/reviews",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId,token,displayName:document.getElementById("name").value,rating:Number(document.getElementById("rating").value),reviewText:document.getElementById("review").value})});const data=await response.json();message.textContent=response.ok?"Thank you. Your review has been submitted.":(data.error||"Could not submit review.");};</script></body></html>`);
});

const pendingSupport = new Set();
const pendingAdminOrderLookup = new Set();
const pendingAdminTracking = new Map();
const pendingAdminNote = new Map();
const pendingStockAdjustment = new Map();
const pendingPromoCreation = new Map();

if (bot) {
  function clearAdminInputs(chatId) {
    pendingAdminOrderLookup.delete(chatId);
    pendingAdminTracking.delete(chatId);
    pendingAdminNote.delete(chatId);
    pendingStockAdjustment.delete(chatId);
    pendingPromoCreation.delete(chatId);
  }
  function getOrderStatusText(order) {
    if (order.paymentStatus === "cancelled" || order.fulfilmentStatus === "cancelled") return "Cancelled ❌";
    if (order.fulfilmentStatus === "shipped") return "Shipped 📦";
    if (order.paymentStatus === "paid") return "Paid ✅";
    if (order.paymentStatus === "payment_submitted") return "Payment submitted ⏳";
    return "Awaiting payment";
  }
  function getRecentOrders(limit = 10) {
    return [...orders.values()].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, limit);
  }
  async function sendLongMessage(chatId, message) {
    const maxLength = 3500;
    if (message.length <= maxLength) return safeSendMessage(chatId, message);
    const paragraphs = message.split("\n\n");
    let chunk = "";
    for (const paragraph of paragraphs) {
      const next = chunk ? `${chunk}\n\n${paragraph}` : paragraph;
      if (next.length > maxLength) {
        if (chunk) await safeSendMessage(chatId, chunk);
        chunk = paragraph;
      } else chunk = next;
    }
    if (chunk) await safeSendMessage(chatId, chunk);
  }
  function dashboardOptions() {
    return { reply_markup: { inline_keyboard: [
      [{ text: "📦 Recent Orders", callback_data: "admin_recent_orders" }, { text: "⏳ Payments", callback_data: "admin_payments" }],
      [{ text: "🚚 Dispatch Queue", callback_data: "admin_dispatch" }, { text: "🔎 Find Order", callback_data: "admin_find_order" }],
      [{ text: "📊 Sales Reports", callback_data: "admin_reports" }, { text: "📦 Stock Centre", callback_data: "admin_stock" }],
      [{ text: "⭐ Reviews", callback_data: "admin_reviews" }, { text: "💰 Affiliate Earnings", callback_data: "admin_earnings" }],
      [{ text: "🎉 Storewide Promo", callback_data: "admin_storewide_promo" }, { text: "🎁 Promotions Manager", callback_data: "admin_promotions" }]
    ] } };
  }
  async function sendAdminDashboard(chatId) {
    clearAdminInputs(chatId);
    const paymentWaiting = [...orders.values()].filter(order => order.paymentStatus === "payment_submitted").length;
    const dispatchWaiting = [...orders.values()].filter(order => order.paymentStatus === "paid" && order.fulfilmentStatus !== "shipped").length;
    const pendingReviews = Number(db.prepare("SELECT COUNT(*) AS count FROM reviews WHERE approved = 0").get()?.count || 0);
    const liveProducts = getLiveProducts();
    const lowStockCount = liveProducts.filter(product => Number.isFinite(Number(product.stock)) && Number(product.stock) > 0 && Number(product.stock) <= LOW_STOCK_THRESHOLD).length;
    const outOfStockCount = liveProducts.filter(product => Number(product.stock) === 0).length;
    const activePromos = [...promotions.values()].filter(promo => promo.active).length;
    return safeSendMessage(chatId, `🛠 ADMIN DASHBOARD\n\n📦 Orders:\n${orders.size}\n\n⏳ Payments waiting:\n${paymentWaiting}\n\n🚚 Ready to dispatch:\n${dispatchWaiting}\n\n⭐ Reviews waiting:\n${pendingReviews}\n\n📉 Low stock:\n${lowStockCount}\n\n❌ Out of stock:\n${outOfStockCount}\n\n🎁 Active Promos:\n${activePromos}\n\nChoose an option below.`, dashboardOptions());
  }
  function promoMenu() {
    return { reply_markup: { inline_keyboard: [
      [{ text: "📋 View Product IDs", callback_data: "admin_product_ids" }, { text: "➕ Create Promotion", callback_data: "promo_create" }],
      [{ text: "🟢 Active Promotions", callback_data: "promo_active" }, { text: "✏️ Edit Promotion", callback_data: "admin_promotions" }],
      [{ text: "⏸ Enable / Disable", callback_data: "admin_promotions" }, { text: "🗑 Delete Promotion", callback_data: "admin_promotions" }],
      [{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]
    ] } };
  }
  async function showPromotionsManager(chatId) {
    clearAdminInputs(chatId);
    const list = [...promotions.values()].sort((a, b) => b.id - a.id);
    const lines = list.map(promo => `${promo.active ? "🟢" : "🔴"} #${promo.id} ${promo.name}\n${promoValueLabel(promo)} · qty ${promo.minQuantity} · ${promo.stackWithReferral ? "stacks" : "no stack"}`).join("\n\n") || "No promotions yet.";
    const buttons = list.map(promo => [{ text: `${promo.active ? "🟢" : "🔴"} ${promo.name}`, callback_data: `promo_manage_${promo.id}` }]);
    buttons.push([{ text: "➕ Create Promotion", callback_data: "promo_create" }, { text: "📋 Product IDs", callback_data: "admin_product_ids" }]);
    buttons.push([{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]);
    return safeSendMessage(chatId, `🎁 PROMOTIONS MANAGER\n\nView IDs, create an offer, then tap a promotion to edit, pause or delete.\n\n${lines}`, { reply_markup: { inline_keyboard: buttons } });
  }
  function productNames(ids) {
    if (ids.includes("all")) return "All products";
    return ids.map(id => productsById.get(Number(id))?.name || `#${id}`).join(", ");
  }
  async function showPromoDetails(chatId, promoId) {
    const promo = promotions.get(Number(promoId));
    if (!promo) return safeSendMessage(chatId, "Promotion not found.");
    return safeSendMessage(chatId, `🎁 PROMOTION #${promo.id}\n\nName: ${promo.name}\nType: ${promoTypeLabel(promo.type)}\nValue: ${promoValueLabel(promo)}\nProducts: ${productNames(promo.productIds)}\nMin qty: ${promo.minQuantity}\nReferral stacking: ${promo.stackWithReferral ? "Allowed" : "Blocked"}\nStatus: ${promo.active ? "🟢 ACTIVE" : "🔴 PAUSED"}`, {
      reply_markup: { inline_keyboard: [
        [{ text: promo.active ? "⏸ Pause" : "▶️ Activate", callback_data: `promo_toggle_${promo.id}` }, { text: "✏️ Edit", callback_data: `promo_edit_${promo.id}` }],
        [{ text: "❌ Delete", callback_data: `promo_delete_${promo.id}` }, { text: "⬅️ Back", callback_data: "admin_promotions" }]
      ] }
    });
  }
  async function sendProductDirectory(chatId) {
    const lines = getLiveProducts().slice().sort((a, b) => Number(a.id) - Number(b.id)).map(product => [
      `#${product.id} — ${product.name}`,
      `Category: ${product.category || "Other"}`,
      `Section: ${product.section || "Other"}`,
      `Price: ${money(Number(product.pricePence || 0))}`,
      `Stock: ${product.stock ?? "Not entered"}`
    ].join("\n"));
    await sendLongMessage(chatId, `📋 PRODUCT ID DIRECTORY\n\n${lines.join("\n\n") || "No products found."}`);
    return safeSendMessage(chatId, "Use these IDs when creating a promotion.", promoMenu());
  }
  function getAdminOrderButtons(order) {
    const buttons = [];
    const cancelled = order.paymentStatus === "cancelled";
    if (!cancelled && order.paymentStatus !== "paid") buttons.push([{ text: "✅ Mark Paid", callback_data: `admin_paid_${order.orderId}` }]);
    if (order.paymentStatus === "paid" && order.fulfilmentStatus !== "shipped") buttons.push([{ text: "🚚 Add Tracking", callback_data: `admin_tracking_${order.orderId}` }]);
    buttons.push([{ text: "📝 Add Note", callback_data: `admin_note_${order.orderId}` }]);
    if (order.paymentStatus === "paid") buttons.push([{ text: "⭐ Send Review Link", callback_data: `admin_review_${order.orderId}` }]);
    if (order.paymentStatus === "awaiting_payment") buttons.push([{ text: "❌ Cancel Order", callback_data: `admin_cancel_${order.orderId}` }]);
    buttons.push([{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]);
    return { reply_markup: { inline_keyboard: buttons } };
  }
  async function showAdminOrder(chatId, order) {
    const items = (order.items || []).map(item => `${item.quantity} × ${item.name}`).join("\n") || "No items";
    const notes = Array.isArray(order.adminNotes) && order.adminNotes.length ? order.adminNotes.map(note => `• ${note.text}`).join("\n") : "None";
    return safeSendMessage(chatId, `📦 ORDER #${order.orderId}\n\nStatus:\n${getOrderStatusText(order)}\n\nCustomer:\n${order.customerName}\n\nTelegram:\n${order.telegramUsername ? `@${normaliseUsername(order.telegramUsername)}` : "Not supplied"}\n\n📍 Address:\n${order.address}\n\nItems:\n${items}\n\nBasket:\n${money(order.subtotalPence)}\n\nDiscount:\n-${money(order.discountPence)}\n\nStore credit:\n-${money(order.storeCreditPence)}\n\nShipping:\n${money(order.shippingPence)}\n\nTOTAL:\n${money(order.totalPence)}\n\nTransaction:\n${order.transactionId || "None"}\n\nTracking:\n${order.trackingNumber || "None"}\n\nAdmin notes:\n${notes}`, getAdminOrderButtons(order));
  }
  async function showOrderList(chatId, title, list) {
    if (!list.length) return safeSendMessage(chatId, `${title}\n\nNothing here.`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] } });
    const buttons = list.slice(0, 20).map(order => [{ text: `#${order.orderId} • ${order.customerName} • ${money(order.totalPence)}`, callback_data: `admin_order_${order.orderId}` }]);
    buttons.push([{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]);
    return safeSendMessage(chatId, `${title}\n\nTap an order to manage it.`, { reply_markup: { inline_keyboard: buttons } });
  }
  async function sendSalesReport(chatId, days, title) {
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const selected = [...orders.values()].filter(order => new Date(order.createdAt || 0).getTime() >= startTime);
    const paid = selected.filter(order => order.paymentStatus === "paid");
    let revenuePence = 0;
    let shippingPence = 0;
    let discountsPence = 0;
    let unitsPaid = 0;
    const sales = new Map();
    for (const order of paid) {
      revenuePence += Number(order.totalPence || 0);
      shippingPence += Number(order.shippingPence || 0);
      discountsPence += Number(order.discountPence || 0);
      for (const item of order.items || []) {
        const qty = Number(item.quantity || 0);
        unitsPaid += qty;
        const key = Number(item.id);
        if (!sales.has(key)) sales.set(key, { name: item.name, units: 0, salesPence: 0 });
        const stat = sales.get(key);
        stat.units += qty;
        stat.salesPence += Number(item.lineTotalPence || Number(item.pricePence || 0) * qty);
      }
    }
    const productLines = [...sales.values()].sort((a, b) => b.units - a.units).map(product => `• ${product.name}\n${product.units} sold • ${money(product.salesPence)}`).join("\n\n");
    await sendLongMessage(chatId, `📊 ${title}\n\nOrders created:\n${selected.length}\n\nPaid orders:\n${paid.length}\n\nRevenue:\n${money(revenuePence)}\n\nAverage paid order:\n${money(paid.length ? Math.round(revenuePence / paid.length) : 0)}\n\nShipping collected:\n${money(shippingPence)}\n\nDiscounts:\n${money(discountsPence)}\n\nUnits sold:\n${unitsPaid}\n\nPRODUCT SALES\n\n${productLines || "No paid sales in this period."}`);
  }
  async function sendPendingReviews(chatId) {
    const pending = db.prepare("SELECT * FROM reviews WHERE approved = 0 ORDER BY id ASC LIMIT 20").all();
    if (!pending.length) return safeSendMessage(chatId, "⭐ Reviews\n\nNo reviews are waiting for approval.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] } });
    for (const review of pending) {
      await safeSendMessage(chatId, `⭐ REVIEW #${review.id}\n\nOrder:\n#${review.order_id}\n\nCustomer:\n${review.display_name}\n\nRating:\n${review.rating}/5\n\nReview:\n${review.review_text}`, {
        reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `review_approve_${review.id}` }, { text: "❌ Reject", callback_data: `review_reject_${review.id}` }], [{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] }
      });
    }
  }
  async function showStockCentre(chatId) {
    const live = getLiveProducts();
    const low = live.filter(product => Number.isFinite(Number(product.stock)) && Number(product.stock) > 0 && Number(product.stock) <= LOW_STOCK_THRESHOLD);
    const out = live.filter(product => Number(product.stock) === 0);
    return safeSendMessage(chatId, `📦 STOCK CENTRE\n\nProducts:\n${live.length}\n\nLow stock:\n${low.length}\n\nOut of stock:\n${out.length}`, {
      reply_markup: { inline_keyboard: [
        [{ text: "📋 All Stock", callback_data: "admin_stock_all" }, { text: "📉 Low Stock", callback_data: "admin_stock_low" }],
        [{ text: "❌ Out of Stock", callback_data: "admin_stock_out" }, { text: "✏️ Adjust Stock", callback_data: "admin_stock_adjust" }],
        [{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]
      ] }
    });
  }
  async function sendStockList(chatId, title, list) {
    await sendLongMessage(chatId, `${title}\n\n${list.map(product => `#${product.id} • ${product.name}: ${product.stock}`).join("\n") || "Nothing here."}`);
  }

  bot.onText(/^\/start(?:@\w+)?(?:\s.*)?$/i, async msg => {
    const buttons = [];
    if (webAppUrl) buttons.push([{ text: "🛍 OPEN SHOP — TAP HERE", web_app: { url: webAppUrl } }]);
    buttons.push([{ text: "📦 My Orders", callback_data: "orders" }, { text: "💬 Support", callback_data: "support" }]);
    buttons.push([{ text: "ℹ️ Info", callback_data: "info" }]);
    if (isAdmin(msg.from?.id)) buttons.push([{ text: "🛠 Admin Dashboard", callback_data: "admin_dashboard" }]);
    await safeSendMessage(msg.chat.id, `⚡️ Welcome\n\n🛍 Open Shop\n📦 My Orders\n💬 Support\nℹ️ Info${isAdmin(msg.from?.id) ? "\n🛠 Admin Dashboard" : ""}`, { reply_markup: { inline_keyboard: buttons } });
  });
  bot.onText(/^\/admin(?:@\w+)?$/i, async msg => isAdmin(msg.from?.id) ? sendAdminDashboard(msg.chat.id) : safeSendMessage(msg.chat.id, "This command is admin-only."));
  bot.onText(/^\/myid(?:@\w+)?$/i, async msg => safeSendMessage(msg.chat.id, `Your Telegram ID: ${msg.from.id}`));
  bot.onText(/^\/earnings(?:@\w+)?$/i, async msg => isAdmin(msg.from?.id) ? sendLongMessage(msg.chat.id, getAffiliateEarningsText()) : safeSendMessage(msg.chat.id, "This command is admin-only."));
  bot.onText(/^\/paid\s+(\d+)$/i, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return safeSendMessage(msg.chat.id, "This command is admin-only.");
    const order = orders.get(Number(match[1]));
    if (!order) return safeSendMessage(msg.chat.id, `❌ Order #${match[1]} not found.`);
    const result = await markOrderPaid(order);
    if (!result.ok) return safeSendMessage(msg.chat.id, `❌ Could not mark order paid.\n\n${result.error}`);
    return safeSendMessage(msg.chat.id, result.alreadyPaid ? `ℹ️ Order #${match[1]} was already paid.` : `✅ Order #${match[1]} marked paid.`);
  });
  bot.onText(/^\/setstock(?:@\w+)?\s+(\d+)\s+(\d+)$/i, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return safeSendMessage(msg.chat.id, "This command is admin-only.");
    const productId = Number(match[1]);
    const newStock = Number(match[2]);
    const product = productsById.get(productId);
    if (!product) return safeSendMessage(msg.chat.id, `❌ Product #${productId} not found.`);
    if (!Number.isInteger(newStock) || newStock < 0) return safeSendMessage(msg.chat.id, "Stock must be a whole number of 0 or more.");
    const oldStock = getLiveStock(productId);
    setInventoryStmt.run(newStock, productId);
    return safeSendMessage(msg.chat.id, `✅ STOCK UPDATED\n\n${product.name}\n\nOld stock: ${oldStock}\nNew stock: ${newStock}`);
  });
  bot.onText(/^\/tracking\s+(\d+)\s+(.+)$/i, async (msg, match) => {
    if (!isAdmin(msg.from?.id)) return safeSendMessage(msg.chat.id, "This command is admin-only.");
    const order = orders.get(Number(match[1]));
    if (!order) return safeSendMessage(msg.chat.id, `❌ Order #${match[1]} not found.`);
    if (order.paymentStatus !== "paid") return safeSendMessage(msg.chat.id, `❌ Order #${match[1]} has not been marked paid.`);
    order.trackingNumber = String(match[2]).trim();
    order.fulfilmentStatus = "shipped";
    order.shippedAt = new Date().toISOString();
    saveOrder(order);
    await safeSendMessage(msg.chat.id, `✅ Tracking saved\n\nOrder:\n#${order.orderId}\n\nTracking:\n${order.trackingNumber}`);
    if (order.telegramId) await safeSendMessage(order.telegramId, `📦 Your order has been dispatched\n\nOrder:\n#${order.orderId}\n\nTracking:\n${order.trackingNumber}`);
  });
  bot.onText(/^\/reviews(?:@\w+)?$/i, async msg => isAdmin(msg.from?.id) ? sendPendingReviews(msg.chat.id) : safeSendMessage(msg.chat.id, "This command is admin-only."));

  bot.on("callback_query", async q => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    const data = String(q.data || "");
    try { await bot.answerCallbackQuery(q.id); } catch {}

    if (data.startsWith("review_approve_") || data.startsWith("review_reject_")) {
      if (!isAdmin(q.from?.id)) return;
      const reviewId = Number(data.replace(/review_(approve|reject)_/, ""));
      const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(reviewId);
      if (!review) return;
      if (data.startsWith("review_approve_")) db.prepare("UPDATE reviews SET approved = 1 WHERE id = ?").run(reviewId);
      else db.prepare("DELETE FROM reviews WHERE id = ?").run(reviewId);
      return;
    }
    if (!data.startsWith("admin_") && !data.startsWith("promo_") && !["orders", "support", "info"].includes(data)) return;
    if ((data.startsWith("admin_") || data.startsWith("promo_")) && !isAdmin(q.from?.id)) return safeSendMessage(chatId, "Admin only.");

    if (data === "admin_dashboard") return sendAdminDashboard(chatId);
    if (data === "admin_promotions" || data === "promo_active") return showPromotionsManager(chatId);
    if (data === "admin_product_ids") return sendProductDirectory(chatId);
    if (data === "promo_create") {
      clearAdminInputs(chatId);
      pendingPromoCreation.set(chatId, { step: "name" });
      return safeSendMessage(chatId, "🎁 CREATE PROMOTION\n\nSend the promotion name.\n\nExample: RT40 2 for 20% off", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_promotions" }]] } });
    }
    if (data.startsWith("promo_type_")) {
      const state = pendingPromoCreation.get(chatId);
      if (!state) return showPromotionsManager(chatId);
      state.type = data.replace("promo_type_", "");
      state.step = "value";
      pendingPromoCreation.set(chatId, state);
      const hint = state.type === "percent"
        ? "Send the percent, 1-100. Example: 20"
        : state.type === "bundle_price"
          ? "Send the bundle price in pence. Example: 4000 for £40"
          : "Send the amount off in pence. Example: 500 for £5 off the line";
      return safeSendMessage(chatId, hint, { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_promotions" }]] } });
    }
    if (data.startsWith("promo_stack_")) {
      const state = pendingPromoCreation.get(chatId);
      if (!state) return showPromotionsManager(chatId);
      state.stackWithReferral = data.endsWith("yes");
      savePromotion(state);
      pendingPromoCreation.delete(chatId);
      return safeSendMessage(chatId, `✅ PROMOTION LIVE\n\n${state.name}\n${promoTypeLabel(state.type)} ${state.type === "percent" ? state.value + "%" : money(state.value)}\nProducts: ${state.productIds.join(", ")}\nMin qty: ${state.minQuantity}\nReferral stacking: ${state.stackWithReferral ? "Allowed" : "Blocked"}`, { reply_markup: { inline_keyboard: [[{ text: "⬅️ Promotions Manager", callback_data: "admin_promotions" }]] } });
    }
    if (data.startsWith("promo_manage_")) return showPromoDetails(chatId, data.replace("promo_manage_", ""));
    if (data.startsWith("promo_toggle_")) {
      const promo = promotions.get(Number(data.replace("promo_toggle_", "")));
      if (!promo) return safeSendMessage(chatId, "Promo not found.");
      promo.active = !promo.active;
      savePromotion(promo);
      return showPromoDetails(chatId, promo.id);
    }
    if (data.startsWith("promo_delete_confirm_")) {
      deletePromotion(Number(data.replace("promo_delete_confirm_", "")));
      return showPromotionsManager(chatId);
    }
    if (data.startsWith("promo_delete_")) {
      const id = data.replace("promo_delete_", "");
      return safeSendMessage(chatId, `Delete promotion #${id}?`, { reply_markup: { inline_keyboard: [[{ text: "❌ Yes, delete", callback_data: `promo_delete_confirm_${id}` }, { text: "Keep", callback_data: `promo_manage_${id}` }]] } });
    }
    if (data.startsWith("promo_edit_")) {
      const promo = promotions.get(Number(data.replace("promo_edit_", "")));
      if (!promo) return;
      clearAdminInputs(chatId);
      pendingPromoCreation.set(chatId, { step: "edit_value", id: promo.id, promo });
      return safeSendMessage(chatId, `✏️ EDIT ${promo.name}\n\nCurrent: ${promoValueLabel(promo)}\n\nSend the new value. Percent as 20, money as pence.`, { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_promotions" }]] } });
    }
    if (data === "admin_recent_orders") return showOrderList(chatId, "📦 RECENT ORDERS", getRecentOrders(15));
    if (data === "admin_payments") return showOrderList(chatId, "⏳ PAYMENTS TO CHECK", getRecentOrders(100).filter(order => order.paymentStatus === "payment_submitted"));
    if (data === "admin_dispatch") return showOrderList(chatId, "🚚 DISPATCH QUEUE", getRecentOrders(100).filter(order => order.paymentStatus === "paid" && order.fulfilmentStatus !== "shipped"));
    if (data === "admin_find_order") {
      clearAdminInputs(chatId);
      pendingAdminOrderLookup.add(chatId);
      return safeSendMessage(chatId, "🔎 FIND ORDER\n\nSend the order number.");
    }
    if (data === "admin_reports") return safeSendMessage(chatId, "📊 SALES REPORTS", { reply_markup: { inline_keyboard: [[{ text: "Today", callback_data: "admin_report_1" }, { text: "7 Days", callback_data: "admin_report_7" }, { text: "30 Days", callback_data: "admin_report_30" }], [{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] } });
    if (data === "admin_report_1") return sendSalesReport(chatId, 1, "TODAY / LAST 24 HOURS");
    if (data === "admin_report_7") return sendSalesReport(chatId, 7, "7 DAY REPORT");
    if (data === "admin_report_30") return sendSalesReport(chatId, 30, "30 DAY REPORT");
    if (data === "admin_stock") return showStockCentre(chatId);
    if (data === "admin_stock_all") return sendStockList(chatId, "📋 ALL STOCK", getLiveProducts());
    if (data === "admin_stock_low") return sendStockList(chatId, "📉 LOW STOCK", getLiveProducts().filter(product => Number(product.stock) > 0 && Number(product.stock) <= LOW_STOCK_THRESHOLD));
    if (data === "admin_stock_out") return sendStockList(chatId, "❌ OUT OF STOCK", getLiveProducts().filter(product => Number(product.stock) === 0));
    if (data === "admin_stock_adjust") {
      clearAdminInputs(chatId);
      pendingStockAdjustment.set(chatId, { stage: "product" });
      return safeSendMessage(chatId, "✏️ ADJUST STOCK\n\nSend the product ID.");
    }
    if (data === "admin_reviews") return sendPendingReviews(chatId);
    if (data === "admin_earnings") return sendLongMessage(chatId, getAffiliateEarningsText());
    if (data === "admin_storewide_promo") {
      const promo = getStorewidePromo();
      return safeSendMessage(chatId, `🎉 STORE-WIDE PROMO\n\nCode:\n${promo.code}\n\nDiscount:\n${promo.discountPercent}%\n\nStatus:\n${isStorewidePromoLive(promo) ? "🟢 ACTIVE" : "🔴 OFF"}`, { reply_markup: { inline_keyboard: [[{ text: isStorewidePromoLive(promo) ? "⏸ Turn Promo Off" : "▶️ Turn Promo On", callback_data: "admin_storewide_toggle" }], [{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] } });
    }
    if (data === "admin_storewide_toggle") {
      const promo = getStorewidePromo();
      setMetaValue("storewidePromo:active", promo.active ? "false" : "true");
      return safeSendMessage(chatId, getStorewidePromo().active ? "✅ Store promo is live." : "⏸ Store promo is off.", { reply_markup: { inline_keyboard: [[{ text: "⬅️ Admin Dashboard", callback_data: "admin_dashboard" }]] } });
    }
    if (data.startsWith("admin_order_")) {
      const order = orders.get(Number(data.replace("admin_order_", "")));
      return order ? showAdminOrder(chatId, order) : safeSendMessage(chatId, "Order not found.");
    }
    if (data.startsWith("admin_paid_")) {
      const order = orders.get(Number(data.replace("admin_paid_", "")));
      if (!order) return safeSendMessage(chatId, "Order not found.");
      const result = await markOrderPaid(order);
      await safeSendMessage(chatId, result.ok ? `✅ Order #${order.orderId} updated.` : `❌ ${result.error}`);
      return showAdminOrder(chatId, order);
    }
    if (data.startsWith("admin_tracking_")) {
      const orderId = Number(data.replace("admin_tracking_", ""));
      if (!orders.get(orderId) || orders.get(orderId).paymentStatus !== "paid") return safeSendMessage(chatId, "Paid order not found.");
      clearAdminInputs(chatId);
      pendingAdminTracking.set(chatId, orderId);
      return safeSendMessage(chatId, `🚚 ADD TRACKING\n\nOrder #${orderId}\n\nSend the tracking number.`);
    }
    if (data.startsWith("admin_note_")) {
      const orderId = Number(data.replace("admin_note_", ""));
      if (!orders.has(orderId)) return safeSendMessage(chatId, "Order not found.");
      clearAdminInputs(chatId);
      pendingAdminNote.set(chatId, orderId);
      return safeSendMessage(chatId, `📝 ADD ADMIN NOTE\n\nOrder #${orderId}\n\nSend the note.`);
    }
    if (data.startsWith("admin_review_")) {
      const order = orders.get(Number(data.replace("admin_review_", "")));
      if (!order || order.paymentStatus !== "paid" || !order.telegramId) return safeSendMessage(chatId, "Cannot send a review link for this order.");
      const reviewUrl = getReviewUrl(order);
      if (!reviewUrl) return safeSendMessage(chatId, "Review link could not be generated.");
      await safeSendMessage(order.telegramId, `⭐ We'd love your feedback\n\nOrder:\n#${order.orderId}`, { reply_markup: { inline_keyboard: [[{ text: "⭐ Leave a Review", url: reviewUrl }]] } });
      return safeSendMessage(chatId, `✅ Review link sent for order #${order.orderId}.`);
    }
    if (data.startsWith("admin_cancel_confirm_")) {
      const order = orders.get(Number(data.replace("admin_cancel_confirm_", "")));
      if (!order || order.paymentStatus !== "awaiting_payment") return safeSendMessage(chatId, "This order can no longer be cancelled.");
      restoreReservedStock(order);
      restoreStoreCreditForOrder(order);
      order.paymentStatus = "cancelled";
      order.fulfilmentStatus = "cancelled";
      order.cancelledAt = new Date().toISOString();
      saveOrder(order);
      if (order.telegramId) await safeSendMessage(order.telegramId, `❌ Order cancelled\n\nOrder:\n#${order.orderId}`);
      return showAdminOrder(chatId, order);
    }
    if (data.startsWith("admin_cancel_")) {
      const orderId = data.replace("admin_cancel_", "");
      return safeSendMessage(chatId, `⚠️ CANCEL ORDER #${orderId}?`, { reply_markup: { inline_keyboard: [[{ text: "❌ Yes, Cancel", callback_data: `admin_cancel_confirm_${orderId}` }, { text: "Keep Order", callback_data: `admin_order_${orderId}` }]] } });
    }
    if (data === "orders") {
      const matches = [...orders.values()].filter(order => orderBelongsToViewer(order, { telegramId: q.from?.id, telegramUsername: q.from?.username })).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 10);
      if (!matches.length) return safeSendMessage(chatId, "📦 My Orders\n\nNo orders found yet.");
      return safeSendMessage(chatId, `📦 My Orders\n\n${matches.map(order => `#${order.orderId} — ${money(order.totalPence)} — ${getOrderStatusText(order)}${order.trackingNumber ? `\nTracking: ${order.trackingNumber}` : ""}`).join("\n\n")}`);
    }
    if (data === "support") {
      if (!supportTelegramIds.length) return safeSendMessage(chatId, "💬 Support\n\nSupport isn't configured yet.");
      pendingSupport.add(chatId);
      return safeSendMessage(chatId, "💬 Support\n\nSend your message below.");
    }
    if (data === "info") return safeSendMessage(chatId, "ℹ️ Info\n\nMinimum basket:\n£50 before discount\n\nDelivery:\n£5\n\nTap Open Shop to launch the Mini App.");
  });

  bot.on("message", async msg => {
    const chatId = msg.chat?.id;
    if (!chatId || !msg.text || msg.text.startsWith("/")) return;
    const text = String(msg.text).trim();

    if (pendingPromoCreation.has(chatId) && isAdmin(msg.from?.id)) {
      const state = pendingPromoCreation.get(chatId);
      if (state.step === "name") {
        state.name = text.slice(0, 80);
        state.step = "type";
        pendingPromoCreation.set(chatId, state);
        return safeSendMessage(chatId, "Choose the discount type.", { reply_markup: { inline_keyboard: [
          [{ text: "Percentage off", callback_data: "promo_type_percent" }],
          [{ text: "Fixed bundle price", callback_data: "promo_type_bundle_price" }],
          [{ text: "Fixed amount off", callback_data: "promo_type_fixed_amount" }],
          [{ text: "❌ Cancel", callback_data: "admin_promotions" }]
        ] } });
      }
      if (state.step === "value") {
        const val = Number(text);
        if (!Number.isFinite(val) || val <= 0 || (state.type === "percent" && val > 100)) return safeSendMessage(chatId, "❌ Send a valid number. Percent must be 1-100.");
        state.value = Math.round(val);
        state.step = "products";
        pendingPromoCreation.set(chatId, state);
        return safeSendMessage(chatId, "Send product IDs, comma separated, or all.\n\nExample: 301, 302", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_promotions" }]] } });
      }
      if (state.step === "products") {
        const ids = text.toLowerCase() === "all" ? ["all"] : text.split(",").map(part => Number(part.trim())).filter(n => Number.isInteger(n) && productsById.has(n));
        if (!ids.length) return safeSendMessage(chatId, "❌ No matching product IDs. Check View Product IDs, or send all.");
        state.productIds = ids;
        state.step = "quantity";
        pendingPromoCreation.set(chatId, state);
        return safeSendMessage(chatId, "Send the minimum quantity.\n\nExample: 2", { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "admin_promotions" }]] } });
      }
      if (state.step === "quantity") {
        const qty = Number(text);
        if (!Number.isInteger(qty) || qty < 1) return safeSendMessage(chatId, "❌ Quantity must be a whole number of 1 or more.");
        state.minQuantity = qty;
        state.step = "stack";
        pendingPromoCreation.set(chatId, state);
        return safeSendMessage(chatId, "Allow referral codes to stack on these products?", { reply_markup: { inline_keyboard: [
          [{ text: "✅ Allow stacking", callback_data: "promo_stack_yes" }],
          [{ text: "🚫 Do not stack", callback_data: "promo_stack_no" }],
          [{ text: "❌ Cancel", callback_data: "admin_promotions" }]
        ] } });
      }
      if (state.step === "edit_value") {
        const val = Number(text);
        if (!Number.isFinite(val) || val <= 0) return safeSendMessage(chatId, "❌ Invalid number.");
        const promo = promotions.get(state.id);
        promo.value = Math.round(val);
        savePromotion(promo);
        pendingPromoCreation.delete(chatId);
        return showPromoDetails(chatId, promo.id);
      }
      return;
    }

    if (pendingAdminOrderLookup.has(chatId) && isAdmin(msg.from?.id)) {
      pendingAdminOrderLookup.delete(chatId);
      const order = orders.get(Number(text.replace(/^#/, "")));
      return order ? showAdminOrder(chatId, order) : safeSendMessage(chatId, "❌ Order not found.");
    }
    if (pendingAdminTracking.has(chatId) && isAdmin(msg.from?.id)) {
      const orderId = pendingAdminTracking.get(chatId);
      pendingAdminTracking.delete(chatId);
      const order = orders.get(orderId);
      if (!order) return safeSendMessage(chatId, "Order not found.");
      order.trackingNumber = text;
      order.fulfilmentStatus = "shipped";
      order.shippedAt = new Date().toISOString();
      saveOrder(order);
      await safeSendMessage(chatId, `✅ Tracking saved\n\nOrder #${orderId}\n${text}`);
      if (order.telegramId) await safeSendMessage(order.telegramId, `📦 Your order has been dispatched\n\nOrder #${orderId}\nTracking: ${text}`);
      return;
    }
    if (pendingAdminNote.has(chatId) && isAdmin(msg.from?.id)) {
      const orderId = pendingAdminNote.get(chatId);
      pendingAdminNote.delete(chatId);
      const order = orders.get(orderId);
      if (!order) return safeSendMessage(chatId, "Order not found.");
      order.adminNotes = Array.isArray(order.adminNotes) ? order.adminNotes : [];
      order.adminNotes.push({ text: text.slice(0, 1000), createdAt: new Date().toISOString() });
      saveOrder(order);
      await safeSendMessage(chatId, `✅ Note added to order #${orderId}.`);
      return showAdminOrder(chatId, order);
    }
    if (pendingStockAdjustment.has(chatId) && isAdmin(msg.from?.id)) {
      const state = pendingStockAdjustment.get(chatId);
      if (state.stage === "product") {
        const product = productsById.get(Number(text.replace(/^#/, "")));
        if (!product) return safeSendMessage(chatId, "❌ Product not found.");
        state.stage = "amount";
        state.productId = Number(product.id);
        pendingStockAdjustment.set(chatId, state);
        return safeSendMessage(chatId, `✏️ ${product.name}\n\nCurrent stock:\n${getLiveStock(product.id)}\n\nSend the new total.`);
      }
      const newStock = Number(text);
      if (!Number.isInteger(newStock) || newStock < 0) return safeSendMessage(chatId, "❌ Send a whole number of 0 or more.");
      setInventoryStmt.run(newStock, state.productId);
      pendingStockAdjustment.delete(chatId);
      return safeSendMessage(chatId, `✅ STOCK UPDATED\n\nNew stock: ${newStock}`, { reply_markup: { inline_keyboard: [[{ text: "📦 Stock Centre", callback_data: "admin_stock" }]] } });
    }
    if (pendingSupport.has(chatId)) {
      pendingSupport.delete(chatId);
      const from = msg.from?.username ? `@${msg.from.username}` : `Telegram ID ${msg.from?.id}`;
      for (const supportId of supportTelegramIds) await safeSendMessage(supportId, `💬 New Support Message\n\nFrom:\n${from}\n\nMessage:\n${text}`);
      return safeSendMessage(chatId, "Thanks — your message has been sent.");
    }
  });
}

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(port, () => {
  console.log(`Storefront running on port ${port}`);
  console.log(`Products: ${products.length}`);
  console.log(`BENS33 discount: ${discountCodes.get("BENS33")?.discountValue}%`);
  console.log(`Promotions loaded: ${promotions.size}`);
});
