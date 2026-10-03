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

const adminTelegramId =

  process.env.ADMIN_TELEGRAM_ID || "";

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

  { code: "KITTYSJ10", owner: "@Sjobje" }

];

/* =========================================================

   TEMPORARY STORE-WIDE PROMO

   ========================================================= */

const STOREWIDE_PROMO_DEFAULTS = {

  code: "WEEKEND10",

  discountPercent: 10,

  active: true,

  startsAt: "2026-10-03T00:00:00+01:00",

  endsAt: "2026-10-05T23:59:59+01:00"

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

          : product.stock

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

    ) === "true",

    startsAt: getMetaValue(

      "storewidePromo:startsAt",

      STOREWIDE_PROMO_DEFAULTS.startsAt

    ),

    endsAt: getMetaValue(

      "storewidePromo:endsAt",

      STOREWIDE_PROMO_DEFAULTS.endsAt

    )

  };

}

function isStorewidePromoLive(

  promo = getStorewidePromo()

) {

  if (!promo.active) {

    return false;

  }

  const now = Date.now();

  const starts = promo.startsAt

    ? new Date(promo.startsAt).getTime()

    : null;

  const ends = promo.endsAt

    ? new Date(promo.endsAt).getTime()

    : null;

  if (

    Number.isFinite(starts) &&

    now < starts

  ) {

    return false;

  }

  if (

    Number.isFinite(ends) &&

    now > ends

  ) {

    return false;

  }

  return true;

}

function storewideDiscountForSubtotal(

  subtotalPence,

  promo

) {

  if (

    !promo ||

    !isStorewidePromoLive(promo)

  ) {

    return 0;

  }

  return Math.min(

    subtotalPence,

    Math.round(

      subtotalPence *

      (

        Number(

          promo.discountPercent ||

          0

        ) /

        100

      )

    )

  );

}

function getAffiliateEarningsText() {

  let totalBalancePence = 0;

  let totalEarnedPence = 0;

  let totalPaidOutPence = 0;

  const sections =

    affiliateCodes.map(

      affiliate => {

        const record =

          referralEarnings.get(

            affiliate.code

          );

        const balancePence =

          Number(

            record?.balancePence ||

            0

          );

        const totalEarnedPenceForCode =

          Number(

            record?.totalEarnedPence ||

            0

          );

        const paidOutPence =

          Number(

            record?.paidOutPence ||

            0

          );

        totalBalancePence +=

          balancePence;

        totalEarnedPence +=

          totalEarnedPenceForCode;

        totalPaidOutPence +=

          paidOutPence;

        return `👤 ${affiliate.owner}

Code: ${affiliate.code}

Currently owed:

${money(balancePence)}

Lifetime earned:

${money(totalEarnedPenceForCode)}

Paid out:

${money(paidOutPence)}`;

      }

    );

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

  const clean =

    normaliseCode(code);

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

  const clean =

    normaliseCode(code);

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

          Number(

            record.discountValue

          ) /

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

  const a =

    normaliseUsername(

      order.telegramUsername

    );

  const b =

    normaliseUsername(

      viewer.telegramUsername

    );

  return Boolean(

    a &&

    b &&

    a === b

  );

}

function isAdmin(userId) {

  return Boolean(

    adminTelegramId &&

    String(userId) ===

      String(adminTelegramId)

  );

}

/* =========================================================

   AFFILIATE CODE SETUP

   Existing earnings are preserved.

   ========================================================= */

for (

  const affiliate

  of affiliateCodes

) {

  saveDiscountCode(

    affiliate.code,

    {

      code:

        affiliate.code,

      discountType:

        "percent",

      discountValue:

        AFFILIATE_DISCOUNT_PERCENT,

      referralOwner:

        affiliate.owner,

      commissionPercent:

        AFFILIATE_COMMISSION_PERCENT,

      cashOnly:

        true,

      active:

        true,

      protected:

        true

    }

  );

  if (

    !referralEarnings.has(

      affiliate.code

    )

  ) {

    saveReferralEarnings(

      affiliate.code,

      {

        code:

          affiliate.code,

        owner:

          affiliate.owner,

        balancePence:

          0,

        totalEarnedPence:

          0,

        paidOutPence:

          0,

        cashOnly:

          true

      }

    );

  } else {

    const existing =

      referralEarnings.get(

        affiliate.code

      );

    existing.owner =

      affiliate.owner;

    existing.cashOnly =

      true;

    existing.balancePence =

      Number(

        existing.balancePence ||

        0

      );

    existing.totalEarnedPence =

      Number(

        existing.totalEarnedPence ||

        0

      );

    existing.paidOutPence =

      Number(

        existing.paidOutPence ||

        0

      );

    saveReferralEarnings(

      affiliate.code,

      existing

    );

  }

}

/* =========================================================

   SEED STORE-WIDE PROMO

   ========================================================= */

if (

  getMetaValue(

    "storewidePromo:code"

  ) ===

  null

) {

  setMetaValue(

    "storewidePromo:code",

    STOREWIDE_PROMO_DEFAULTS.code

  );

}

if (

  getMetaValue(

    "storewidePromo:discountPercent"

  ) ===

  null

) {

  setMetaValue(

    "storewidePromo:discountPercent",

    STOREWIDE_PROMO_DEFAULTS.discountPercent

  );

}

if (

  getMetaValue(

    "storewidePromo:active"

  ) ===

  null

) {

  setMetaValue(

    "storewidePromo:active",

    STOREWIDE_PROMO_DEFAULTS.active

  );

}

if (

  getMetaValue(

    "storewidePromo:startsAt"

  ) ===

  null

) {

  setMetaValue(

    "storewidePromo:startsAt",

    STOREWIDE_PROMO_DEFAULTS.startsAt

  );

}

if (

  getMetaValue(

    "storewidePromo:endsAt"

  ) ===

  null

) {

  setMetaValue(

    "storewidePromo:endsAt",

    STOREWIDE_PROMO_DEFAULTS.endsAt

  );

}

/* =========================================================

   TELEGRAM BOT

   ========================================================= */

let bot = null;

if (token) {

  try {

    bot = new TelegramBot(

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

  } catch (err) {

    console.error(

      "Telegram startup failed:",

      err

    );

  }

} else {

  console.warn(

    "Telegram bot token missing."

  );

}

/* =========================================================

   TELEGRAM HELPERS

   ========================================================= */

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

async function sendToAdmins(

  message,

  options

) {

  if (

    !adminTelegramId

  ) {

    return;

  }

  await safeSendMessage(

    adminTelegramId,

    message,

    options

  );

}

/* =========================================================

   ORDER HELPERS

   ========================================================= */

function getSortedOrders() {

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

    );

}

function getOrderStatusText(

  order

) {

  if (

    order.paymentStatus ===

    "cancelled"

  ) {

    return "Cancelled ❌";

  }

  if (

    order.fulfilmentStatus ===

    "completed"

  ) {

    return "Completed ✅";

  }

  if (

    order.fulfilmentStatus ===

    "shipped"

  ) {

    return "Dispatched 🚚";

  }

  if (

    order.fulfilmentStatus ===

    "packed"

  ) {

    return "Packed 📦";

  }

  if (

    order.fulfilmentStatus ===

    "needs_packing"

  ) {

    return "Needs packing 🧺";

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

/* =========================================================

   TIMELINE

   ========================================================= */

function ensureTimeline(

  order

) {

  if (

    !Array.isArray(

      order.timeline

    )

  ) {

    order.timeline = [];

  }

}

function addTimeline(

  order,

  status,

  by = "system",

  details = ""

) {

  ensureTimeline(

    order

  );

  order.timeline.push({

    status,

    by:

      String(

        by

      ),

    details:

      String(

        details ||

        ""

      ),

    createdAt:

      new Date()

        .toISOString()

  });

}

/* =========================================================

   AFFILIATE COMMISSION

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

  const code =

    normaliseCode(

      order.discountCode

    );

  const record =

    referralEarnings.get(

      code

    ) || {

      code,

      owner:

        order.referralOwner ||

        null,

      balancePence:

        0,

      totalEarnedPence:

        0,

      paidOutPence:

        0,

      cashOnly:

        true

    };

  record.owner =

    record.owner ||

    order.referralOwner ||

    null;

  record.balancePence =

    Number(

      record.balancePence ||

      0

    ) +

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

  order.referralCredited =

    true;

  saveOrder(

    order

  );

}

/* =========================================================

   STOCK ALERTS

   ========================================================= */

async function alertStockChange(

  product,

  previousStock,

  newStock

) {

  if (

    !product

  ) {

    return;

  }

  if (

    Number(

      newStock

    ) ===

      0 &&

    Number(

      previousStock

    ) !==

      0

  ) {

    await sendToAdmins(

`❌ OUT OF STOCK

${product.name}

Product ID:

${product.id}

Stock:

0`

    );

    return;

  }

  if (

    Number(

      newStock

    ) >

      0 &&

    Number(

      newStock

    ) <=

      LOW_STOCK_THRESHOLD &&

    Number(

      previousStock

    ) >

      LOW_STOCK_THRESHOLD

  ) {

    await sendToAdmins(

`📉 LOW STOCK ALERT

${product.name}

Product ID:

${product.id}

Remaining:

${newStock}

Alert level:

${LOW_STOCK_THRESHOLD}`

    );

  }

}

/* =========================================================

   DEDUCT STOCK

   ========================================================= */

async function deductStockForOrder(

  order

) {

  if (

    order.stockDeducted

  ) {

    return {

      ok: true,

      alreadyDone: true

    };

  }

  for (

    const item

    of order.items ||

    []

  ) {

    const stock =

      getLiveStock(

        item.id

      );

    if (

      stock !==

        null &&

      stock <

        Number(

          item.quantity

        )

    ) {

      return {

        ok: false,

        error:

          `Not enough stock remaining for ${item.name}. Available: ${stock}.`

      };

    }

  }

  const changes = [];

  db.exec(

    "BEGIN"

  );

  try {

    for (

      const item

      of order.items ||

      []

    ) {

      const oldStock =

        getLiveStock(

          item.id

        );

      if (

        oldStock ===

        null

      ) {

        continue;

      }

      const newStock =

        oldStock -

        Number(

          item.quantity

        );

      setInventoryStmt.run(

        newStock,

        Number(

          item.id

        )

      );

      changes.push({

        product:

          productsById.get(

            Number(

              item.id

            )

          ) ||

          item,

        oldStock,

        newStock

      });

    }

    db.exec(

      "COMMIT"

    );

  } catch (err) {

    db.exec(

      "ROLLBACK"

    );

    throw err;

  }

  order.stockDeducted =

    true;

  order.stockDeductedAt =

    new Date()

      .toISOString();

  saveOrder(

    order

  );

  for (

    const change

    of changes

  ) {

    await alertStockChange(

      change.product,

      change.oldStock,

      change.newStock

    );

  }

  return {

    ok: true

  };

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

    if (

      !response.ok

    ) {

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

      !Number.isFinite(

        gbpPerUsdt

      ) ||

      gbpPerUsdt <=

        0

    ) {

      throw new Error(

        "Invalid GBP/USDT rate"

      );

    }

    return (

      (

        Number(

          totalPence

        ) /

        100

      ) /

      gbpPerUsdt

    )

      .toFixed(2);

  } catch (err) {

    console.error(

      "USDT QUOTE ERROR:",

      err?.message ||

      err

    );

    return null;

  }

}

/* =========================================================

   MARK ORDER PAID

   ========================================================= */

async function markOrderPaid(

  order,

  adminId = "system"

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

      error: "This order has been cancelled."

    };

  }

  const stockResult =

    await deductStockForOrder(

      order

    );

  if (

    !stockResult.ok

  ) {

    return stockResult;

  }

  order.paymentStatus =

    "paid";

  order.fulfilmentStatus =

    "needs_packing";

  order.paidAt =

    new Date()

      .toISOString();

  addTimeline(

    order,

    "paid",

    adminId,

    "Payment confirmed"

  );

  addTimeline(

    order,

    "needs_packing",

    adminId,

    "Moved to packing queue"

  );

  saveOrder(

    order

  );

  if (

    Number(

      order.referralCommissionPence ||

      0

    ) >

      0 &&

    !order.referralCredited

  ) {

    creditReferralForOrder(

      order

    );

  }

  await sendToAdmins(

`✅ PAYMENT CONFIRMED

Order:

#${order.orderId}

Customer:

${order.customerName}

Total:

${money(

  order.totalPence

)}

${

  order.discountCode &&

  order.referralCommissionPence

    ? `Affiliate:

${order.referralOwner}

Code:

${order.discountCode}

Commission:

${money(

  order.referralCommissionPence

)}

`

    : ""

}Status:

Needs packing 🧺`

  );

  if (

    order.telegramId

  ) {

    await safeSendMessage(

      order.telegramId,

`✅ Payment confirmed

Order:

#${order.orderId}

Total:

${money(

  order.totalPence

)}

Your order is now being prepared.`

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

  (

    _req,

    res

  ) => {

    const promo =

      getStorewidePromo();

    res.json({

      ok: true,

      products:

        products.length,

      orders:

        orders.size,

      telegramConfigured:

        Boolean(

          token

        ),

      paymentAddressConfigured:

        Boolean(

          receivingAddress

        ),

      affiliates:

        affiliateCodes.length,

      storewidePromo: {

        code:

          promo.code,

        discountPercent:

          promo.discountPercent,

        active:

          promo.active,

        live:

          isStorewidePromoLive(

            promo

          ),

        startsAt:

          promo.startsAt,

        endsAt:

          promo.endsAt

      }

    });

  }

);

/* =========================================================

   CART EVENTS

   ========================================================= */

app.post(

  "/api/cart-events",

  (

    req,

    res

  ) => {

    const productId =

      Number(

        req.body?.productId

      );

    const action =

      String(

        req.body?.action ||

        ""

      );

    if (

      !productsById.has(

        productId

      ) ||

      ![

        "add",

        "remove"

      ].includes(

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

      new Date()

        .toISOString()

    );

    return res.json({

      ok: true

    });

  }

);

/* =========================================================

   AFFILIATE DISCOUNT LOOKUP

   ========================================================= */

app.get(

  "/api/discount-codes/:code",

  (

    req,

    res

  ) => {

    const code =

      normaliseCode(

        req.params.code

      );

    const record =

      discountCodes.get(

        code

      );

    if (

      !record ||

      record.active ===

        false

    ) {

      return res

        .status(404)

        .json({

          valid: false,

          error: "That code isn't valid."

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

  (

    req,

    res

  ) => {

    const enteredCode =

      normaliseCode(

        req.params.code

      );

    const promo =

      getStorewidePromo();

    if (

      !promo.active

    ) {

      return res

        .status(404)

        .json({

          valid: false,

          error: "The store-wide promotion is currently switched off."

        });

    }

    if (

      enteredCode !==

      promo.code

    ) {

      return res

        .status(404)

        .json({

          valid: false,

          error: "That store-wide promo code isn't valid."

        });

    }

    if (

      !isStorewidePromoLive(

        promo

      )

    ) {

      return res

        .status(404)

        .json({

          valid: false,

          error: "That promotion isn't currently active."

        });

    }

    return res.json({

      valid: true,

      code:

        promo.code,

      discountPercent:

        promo.discountPercent,

      stacksWithAffiliate:

        true,

      startsAt:

        promo.startsAt,

      endsAt:

        promo.endsAt

    });

  }

);

/* =========================================================

   AFFILIATE EARNINGS LOOKUP

   ========================================================= */

app.get(

  "/api/referral-codes/:code/earnings",

  (

    req,

    res

  ) => {

    const code =

      normaliseCode(

        req.params.code

      );

    const record =

      referralEarnings.get(

        code

      );

    if (

      !record

    ) {

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

      cashOnly:

        record.cashOnly ===

        true

    });

  }

);
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});