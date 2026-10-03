import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const app = express();

const port =
  Number(process.env.PORT || 3000);

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
   MULTIPLE ADMIN TELEGRAM IDS

   Render example:
   ADMIN_TELEGRAM_IDS=YOUR_ID,8729008732

   ADMIN_TELEGRAM_ID remains supported as a fallback.
   ========================================================= */

const adminTelegramIds =
  (
    process.env.ADMIN_TELEGRAM_IDS ||
    process.env.ADMIN_TELEGRAM_ID ||
    ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const primaryAdminTelegramId =
  adminTelegramIds[0] || "";

const supportTelegramIds =
  (
    process.env.SUPPORT_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

/* =========================================================
   DATA DIRECTORY
   ========================================================= */

const DATA_DIR =
  process.env.DATA_DIR || ".";

/* =========================================================
   SHOP SETTINGS
   ========================================================= */

const MINIMUM_ORDER_PENCE = 5000;
const SHIPPING_PENCE = 500;
const LOW_STOCK_THRESHOLD = 5;

/* =========================================================
   Y8 REFERRAL CODE
   ========================================================= */

const Y8_CODE = "Y8";
const Y8_OWNER = "@Y8_JKO";
const Y8_DISCOUNT_PERCENT = 10;
const Y8_COMMISSION_PERCENT = 5;

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   DATABASE
   ========================================================= */

mkdirSync(
  DATA_DIR,
  {
    recursive: true
  }
);

const db =
  new DatabaseSync(
    path.join(
      DATA_DIR,
      "kage.sqlite"
    )
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

const upsertOrderStmt =
  db.prepare(`
    INSERT INTO orders (
      id,
      json
    )
    VALUES (?, ?)

    ON CONFLICT(id)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertDiscountStmt =
  db.prepare(`
    INSERT INTO discount_codes (
      code,
      json
    )
    VALUES (?, ?)

    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertReferralStmt =
  db.prepare(`
    INSERT INTO referral_earnings (
      code,
      json
    )
    VALUES (?, ?)

    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertMetaStmt =
  db.prepare(`
    INSERT INTO meta (
      key,
      value
    )
    VALUES (?, ?)

    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value
  `);

const insertCartEventStmt =
  db.prepare(`
    INSERT INTO cart_events (
      productId,
      action,
      createdAt
    )
    VALUES (?, ?, ?)
  `);

const insertInventoryStmt =
  db.prepare(`
    INSERT OR IGNORE INTO inventory (
      product_id,
      stock
    )
    VALUES (?, ?)
  `);

const getInventoryStmt =
  db.prepare(`
    SELECT stock
    FROM inventory
    WHERE product_id = ?
  `);

const setInventoryStmt =
  db.prepare(`
    UPDATE inventory
    SET stock = ?
    WHERE product_id = ?
  `);

/* =========================================================
   PRODUCT CATALOGUE
   ========================================================= */

let products = [];

try {
  products =
    JSON.parse(
      readFileSync(
        path.join(
          __dirname,
          "public",
          "products.json"
        ),
        "utf8"
      )
    );

  if (
    !Array.isArray(products)
  ) {
    throw new Error(
      "products.json must contain an array."
    );
  }

} catch (err) {
  console.error(
    "PRODUCT LOAD ERROR:",
    err
  );

  process.exit(1);
}

const productsById =
  new Map(
    products.map(
      product => [
        Number(product.id),
        product
      ]
    )
  );

/* =========================================================
   INITIALISE LIVE INVENTORY
   ========================================================= */

for (
  const product
  of products
) {
  const id =
    Number(product.id);

  const originalStock =
    Number(product.stock);

  if (
    !Number.isInteger(id)
  ) {
    continue;
  }

  if (
    Number.isFinite(
      originalStock
    )
  ) {
    insertInventoryStmt.run(
      id,
      Math.max(
        0,
        Math.floor(
          originalStock
        )
      )
    );
  }
}

/* =========================================================
   LIVE PRODUCT HELPERS
   ========================================================= */

function getLiveStock(
  productId
) {
  const row =
    getInventoryStmt.get(
      Number(productId)
    );

  if (
    !row
  ) {
    return null;
  }

  return Number(
    row.stock
  );
}

function getLiveProducts() {
  return products.map(
    product => {
      const liveStock =
        getLiveStock(
          product.id
        );

      return {
        ...product,

        stock:
          liveStock !== null
            ? liveStock
            : product.stock
      };
    }
  );
}

/* =========================================================
   LIVE PRODUCT ROUTES
   ========================================================= */

app.get(
  "/products.json",

  (_req, res) => {
    res.json(
      getLiveProducts()
    );
  }
);

app.get(
  "/api/products",

  (_req, res) => {
    res.json(
      getLiveProducts()
    );
  }
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* =========================================================
   MEMORY
   ========================================================= */

const orders =
  new Map();

const discountCodes =
  new Map();

const referralEarnings =
  new Map();

let nextOrderId =
  1001;

/* =========================================================
   LOAD ORDERS
   ========================================================= */

for (
  const row of db
    .prepare(
      "SELECT id, json FROM orders"
    )
    .all()
) {
  try {
    orders.set(
      Number(row.id),
      JSON.parse(
        row.json
      )
    );
  } catch {}
}

/* =========================================================
   LOAD DISCOUNT CODES
   ========================================================= */

for (
  const row of db
    .prepare(
      "SELECT code, json FROM discount_codes"
    )
    .all()
) {
  try {
    discountCodes.set(
      String(
        row.code
      ).toUpperCase(),

      JSON.parse(
        row.json
      )
    );
  } catch {}
}

/* =========================================================
   LOAD REFERRAL EARNINGS
   ========================================================= */

for (
  const row of db
    .prepare(
      "SELECT code, json FROM referral_earnings"
    )
    .all()
) {
  try {
    referralEarnings.set(
      String(
        row.code
      ).toUpperCase(),

      JSON.parse(
        row.json
      )
    );
  } catch {}
}

/* =========================================================
   NEXT ORDER ID
   ========================================================= */

const savedNextOrderId =
  db
    .prepare(
      "SELECT value FROM meta WHERE key = ?"
    )
    .get(
      "nextOrderId"
    );

if (
  savedNextOrderId
) {
  nextOrderId =
    Number(
      savedNextOrderId.value
    ) ||
    1001;
}

/* =========================================================
   HELPERS
   ========================================================= */

function money(
  pence
) {
  return `£${(
    Number(
      pence || 0
    ) /
    100
  ).toFixed(2)}`;
}

function normaliseCode(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .toUpperCase();
}

function normaliseUsername(
  value
) {
  return String(
    value || ""
  )
    .replace(
      /^@/,
      ""
    )
    .trim()
    .toLowerCase();
}

function saveOrder(
  order
) {
  orders.set(
    Number(
      order.orderId
    ),
    order
  );

  upsertOrderStmt.run(
    Number(
      order.orderId
    ),
    JSON.stringify(
      order
    )
  );
}

function saveNextOrderId(
  value
) {
  nextOrderId =
    value;

  upsertMetaStmt.run(
    "nextOrderId",
    String(value)
  );
}

function saveDiscountCode(
  code,
  record
) {
  const clean =
    normaliseCode(
      code
    );

  discountCodes.set(
    clean,
    record
  );

  upsertDiscountStmt.run(
    clean,
    JSON.stringify(
      record
    )
  );
}

function saveReferralEarnings(
  code,
  record
) {
  const clean =
    normaliseCode(
      code
    );

  referralEarnings.set(
    clean,
    record
  );

  upsertReferralStmt.run(
    clean,
    JSON.stringify(
      record
    )
  );
}

function calculateDiscount(
  subtotalPence,
  record
) {
  if (
    !record
  ) {
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
    String(
      viewer.telegramId
    ) ===
    String(
      order.telegramId
    )
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

/* =========================================================
   MULTI-ADMIN HELPERS
   ========================================================= */

function isAdmin(
  userId
) {
  if (
    userId === undefined ||
    userId === null
  ) {
    return false;
  }

  return adminTelegramIds.includes(
    String(userId)
  );
}

/* =========================================================
   Y8 REFERRAL
   ========================================================= */

saveDiscountCode(
  Y8_CODE,
  {
    code:
      Y8_CODE,

    discountType:
      "percent",

    discountValue:
      Y8_DISCOUNT_PERCENT,

    referralOwner:
      Y8_OWNER,

    commissionPercent:
      Y8_COMMISSION_PERCENT,

    cashOnly:
      true,

    active:
      true
  }
);

if (
  !referralEarnings.has(
    Y8_CODE
  )
) {
  saveReferralEarnings(
    Y8_CODE,
    {
      code:
        Y8_CODE,

      owner:
        Y8_OWNER,

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
      Y8_CODE
    );

  existing.owner =
    Y8_OWNER;

  existing.cashOnly =
    true;

  saveReferralEarnings(
    Y8_CODE,
    existing
  );
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
        false
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
   RESTORE STORE CREDIT AFTER CANCELLATION
   ========================================================= */

function restoreStoreCreditForOrder(
  order
) {
  if (
    !order ||
    order.storeCreditRestored ||
    !order.storeCreditCode ||
    Number(
      order.storeCreditPence ||
      0
    ) <= 0
  ) {
    return false;
  }

  const code =
    normaliseCode(
      order.storeCreditCode
    );

  const record =
    referralEarnings.get(
      code
    );

  if (
    !record ||
    record.cashOnly === true
  ) {
    return false;
  }

  record.balancePence =
    Number(
      record.balancePence ||
      0
    ) +
    Number(
      order.storeCreditPence ||
      0
    );

  saveReferralEarnings(
    code,
    record
  );

  order.storeCreditRestored =
    true;

  order.storeCreditRestoredAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );

  return true;
}

/* =========================================================
   STOCK DEDUCTION
   ========================================================= */

function deductStockForOrder(
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
    of order.items
  ) {
    const liveStock =
      getLiveStock(
        item.id
      );

    if (
      liveStock === null
    ) {
      continue;
    }

    if (
      liveStock <
      Number(
        item.quantity
      )
    ) {
      return {
        ok: false,

        error:
          `Not enough stock remaining for ${item.name}. Available: ${liveStock}.`
      };
    }
  }

  db.exec(
    "BEGIN"
  );

  try {
    for (
      const item
      of order.items
    ) {
      const liveStock =
        getLiveStock(
          item.id
        );

      if (
        liveStock === null
      ) {
        continue;
      }

      const newStock =
        liveStock -
        Number(
          item.quantity
        );

      setInventoryStmt.run(
        newStock,
        Number(
          item.id
        )
      );
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
      gbpPerUsdt <= 0
    ) {
      throw new Error(
        "Invalid GBP/USDT rate"
      );
    }

    const pounds =
      Number(
        totalPence
      ) /
      100;

    return (
      pounds /
      gbpPerUsdt
    ).toFixed(2);

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
   TELEGRAM STARTUP
   ========================================================= */

let bot =
  null;

if (
  token
) {
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

/* =========================================================
   SEND NOTIFICATION TO EVERY ADMIN
   ========================================================= */

async function sendToAdmins(
  message,
  options
) {
  for (
    const adminId
    of adminTelegramIds
  ) {
    await safeSendMessage(
      adminId,
      message,
      options
    );
  }
}

/* =========================================================
   REVIEW URL
   ========================================================= */

function getReviewUrl(
  order
) {
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

  const stockResult =
    deductStockForOrder(
      order
    );

  if (
    !stockResult.ok
  ) {
    return stockResult;
  }

  order.paymentStatus =
    "paid";

  order.paidAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );

  if (
    order.referralCommissionPence >
      0 &&
    !order.referralCredited
  ) {
    creditReferralForOrder(
      order
    );
  }

  const itemLines =
    order.items
      .map(
        item =>
          `${item.quantity} × ${item.name}`
      )
      .join("\n");

  await sendToAdmins(

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
${money(
  order.subtotalPence
)}

Discount:
-${money(
  order.discountPence
)}

Store credit:
-${money(
  order.storeCreditPence
)}

Shipping:
${money(
  order.shippingPence
)}

TOTAL:
${money(
  order.totalPence
)}

Transaction:
${
  order.transactionId ||
  "Marked paid manually"
}

Stock updated:
✅`
  );

  if (
    order.telegramId
  ) {
    const reviewUrl =
      getReviewUrl(
        order
      );

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
${money(
  order.totalPence
)}

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

  (
    _req,
    res
  ) => {
    res.json({
      ok: true,

      products:
        products.length,

      minimumOrderPence:
        MINIMUM_ORDER_PENCE,

      shippingPence:
        SHIPPING_PENCE,

      y8Loaded:
        discountCodes.has(
          Y8_CODE
        ),

      y8Owner:
        Y8_OWNER,

      telegramConfigured:
        Boolean(
          token
        ),

      adminCount:
        adminTelegramIds.length,

      receivingAddressConfigured:
        Boolean(
          receivingAddress
        ),

      etherscanConfigured:
        Boolean(
          etherscanApiKey
        )
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
      req.body?.action;

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
   REFERRAL EARNINGS
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
        storeCreditCode
      } =
        req.body ||
        {};

      if (
        !customerName ||
        !address ||
        !Array.isArray(
          items
        ) ||
        items.length ===
          0
      ) {
        return res
          .status(400)
          .json({
            error:
              "Missing order details"
          });
      }

      const lineItems =
        [];

      let subtotalPence =
        0;

      for (
        const rawItem
        of items
      ) {
        const id =
          Number(
            rawItem?.id
          );

        const quantity =
          Number(
            rawItem?.quantity
          );

        const product =
          productsById.get(
            id
          );

        if (
          !product ||
          !Number.isInteger(
            quantity
          ) ||
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
          getLiveStock(
            id
          );

        if (
          liveStock !== null &&
          quantity >
            liveStock
        ) {
          return res
            .status(400)
            .json({
              error:
                `Not enough stock for ${product.name}. Available: ${liveStock}.`
            });
        }

        const pricePence =
          Number(
            product.pricePence
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
            Number(
              product.id
            ),

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

      let discountPence =
        0;

      let appliedDiscountCode =
        null;

      let referralOwner =
        null;

      let referralCommissionPence =
        0;

      if (
        discountCode
      ) {
        const code =
          normaliseCode(
            discountCode
          );

        const record =
          discountCodes.get(
            code
          );

        if (
          record &&
          record.active !==
            false
        ) {
          discountPence =
            calculateDiscount(
              subtotalPence,
              record
            );

          appliedDiscountCode =
            code;

          if (
            record.referralOwner &&
            Number(
              record.commissionPercent
            ) >
              0
          ) {
            referralOwner =
              record.referralOwner;

            referralCommissionPence =
              Math.round(
                subtotalPence *
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

      let storeCreditPence =
        0;

      let appliedCreditCode =
        null;

      if (
        storeCreditCode
      ) {
        const code =
          normaliseCode(
            storeCreditCode
          );

        const credit =
          referralEarnings.get(
            code
          );

        if (
          credit &&
          credit.cashOnly !==
            true
        ) {
          const remaining =
            Math.max(
              0,

              subtotalPence -
              discountPence
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
            storeCreditPence >
            0
          ) {
            appliedCreditCode =
              code;

            credit.balancePence =
              Math.max(
                0,

                Number(
                  credit.balancePence ||
                  0
                ) -
                storeCreditPence
              );

            saveReferralEarnings(
              code,
              credit
            );
          }
        }
      }

      const productsAfterDiscount =
        Math.max(
          0,

          subtotalPence -
          discountPence -
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
        nextOrderId +
        1
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

        storeCreditPence,

        shippingPence,

        totalPence,

        discountCode:
          appliedDiscountCode,

        storeCreditCode:
          appliedCreditCode,

        storeCreditRestored:
          false,

        referralOwner,

        referralCommissionPence,

        referralCredited:
          false,

        stockDeducted:
          false,

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

        adminNotes:
          [],

        reviewToken:
          randomUUID(),

        createdAt:
          new Date()
            .toISOString()
      };

      saveOrder(
        order
      );

      const itemLines =
        lineItems
          .map(
            item =>
              `${item.quantity} × ${item.name}`
          )
          .join("\n");

      await sendToAdmins(

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
${money(
  subtotalPence
)}

Discount:
-${money(
  discountPence
)}

Store credit:
-${money(
  storeCreditPence
)}

Shipping:
${money(
  shippingPence
)}

TOTAL:
${money(
  totalPence
)}

${
  appliedDiscountCode
    ? `Discount code: ${appliedDiscountCode}`
    : "Discount code: None"
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
Awaiting payment`
      );

      return res.json({
        ok: true,

        orderId,

        subtotalPence,

        discountPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        status:
          order.paymentStatus,

        payment: {
          method:
            "crypto",

          network:
            "ERC-20",

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
        Number(
          req.params.id
        )
      );

    if (
      !order
    ) {
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
        Number(
          req.params.id
        )
      );

    if (
      !order
    ) {
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
      [
        ...orders.values()
      ].some(
        existing =>
          existing.orderId !==
            order.orderId &&
          existing.transactionId
            ?.toLowerCase() ===
          transactionId
            .toLowerCase()
      );

    if (
      alreadyUsed
    ) {
      return res
        .status(400)
        .json({
          error:
            "That transaction has already been used."
        });
    }

    order.transactionId =
      transactionId;

    /*
      A submitted transaction hash is NOT
      treated as confirmed payment.

      An admin must independently verify it
      and then mark the order paid.
    */

    order.paymentStatus =
      "payment_submitted";

    saveOrder(
      order
    );

    await sendToAdmins(

`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

📍 Delivery Address:
${order.address}

Expected total:
${money(
  order.totalPence
)}

Transaction:
${transactionId}

Use:
/paid ${order.orderId}

once payment has been independently confirmed.`
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

  (
    _req,
    res
  ) => {
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

    return res.json(
      rows
    );
  }
);

app.post(
  "/api/reviews",

  (
    req,
    res
  ) => {
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
        .slice(
          0,
          50
        );

    const reviewText =
      String(
        req.body?.reviewText ||
        ""
      )
        .trim()
        .slice(
          0,
          1000
        );

    const order =
      orders.get(
        orderId
      );

    if (
      !order
    ) {
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
      !Number.isInteger(
        rating
      ) ||
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

    if (
      !reviewText
    ) {
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
        display_name =
          excluded.display_name,
        rating =
          excluded.rating,
        review_text =
          excluded.review_text,
        approved = 0,
        created_at =
          excluded.created_at
    `).run(
      orderId,

      String(
        order.telegramId ||
        ""
      ),

      displayName,

      rating,

      reviewText,

      new Date()
        .toISOString()
    );

    const savedReview =
      db.prepare(`
        SELECT *
        FROM reviews
        WHERE order_id = ?
      `).get(
        orderId
      );

    if (
      savedReview
    ) {
      sendToAdmins(

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
      orders.get(
        orderId
      );

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

    res.type(
      "html"
    );

    return res.send(`
<!DOCTYPE html>
<html lang="en">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
Leave a Review
</title>

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

<option value="5">
★★★★★ - 5
</option>

<option value="4">
★★★★☆ - 4
</option>

<option value="3">
★★★☆☆ - 3
</option>

<option value="2">
★★☆☆☆ - 2
</option>

<option value="1">
★☆☆☆☆ - 1
</option>

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

const orderId =
  ${orderId};

const token =
  ${tokenJson};

document
  .getElementById(
    "submit"
  )
  .addEventListener(
    "click",

    async () => {
      const button =
        document
          .getElementById(
            "submit"
          );

      const message =
        document
          .getElementById(
            "message"
          );

      button.disabled =
        true;

      message.textContent =
        "Submitting...";

      try {
        const response =
          await fetch(
            "/api/reviews",

            {
              method:
                "POST",

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

        if (
          !response.ok
        ) {
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

        button.disabled =
          false;
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

if (
  bot
) {

  /* =======================================================
     ADMIN INPUT STATE
     ======================================================= */

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
  }

  /* =======================================================
     ORDER STATUS
     ======================================================= */

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

  /* =======================================================
     RECENT ORDERS
     ======================================================= */

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
      .slice(
        0,
        limit
      );
  }

  /* =======================================================
     LONG MESSAGES
     ======================================================= */

  async function sendLongMessage(
    chatId,
    message
  ) {
    const maxLength =
      3500;

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
      message.split(
        "\n\n"
      );

    let chunk =
      "";

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
        if (
          chunk
        ) {
          await safeSendMessage(
            chatId,
            chunk
          );
        }

        chunk =
          paragraph;

      } else {
        chunk =
          next;
      }
    }

    if (
      chunk
    ) {
      await safeSendMessage(
        chatId,
        chunk
      );
    }
  }

  /* =======================================================
     ADMIN DASHBOARD BUTTONS
     ======================================================= */

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
                "💰 Y8 Earnings",

              callback_data:
                "admin_earnings"
            }
          ]
        ]
      }
    };
  }

  /* =======================================================
     ADMIN DASHBOARD
     ======================================================= */

  async function sendAdminDashboard(
    chatId
  ) {
    clearAdminInputs(
      chatId
    );

    const paymentWaiting =
      [
        ...orders.values()
      ]
        .filter(
          order =>
            order.paymentStatus ===
            "payment_submitted"
        )
        .length;

    const dispatchWaiting =
      [
        ...orders.values()
      ]
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
              Number.isFinite(
                stock
              ) &&
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
            Number(
              product.stock
            ) ===
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

Admins configured:
${adminTelegramIds.length}

Choose an option below.`,

      getAdminDashboardOptions()
    );
  }

  /* =======================================================
     ADMIN ORDER BUTTONS
     ======================================================= */

  function getAdminOrderButtons(
    order
  ) {
    const buttons =
      [];

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

  /* =======================================================
     SHOW ADMIN ORDER
     ======================================================= */

  async function showAdminOrder(
    chatId,
    order
  ) {
    const items =
      (
        order.items ||
        []
      )
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
${getOrderStatusText(
  order
)}

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
${money(
  order.subtotalPence
)}

Discount:
-${money(
  order.discountPence
)}

Store credit:
-${money(
  order.storeCreditPence
)}

Shipping:
${money(
  order.shippingPence
)}

TOTAL:
${money(
  order.totalPence
)}

Transaction:
${order.transactionId || "None"}

Tracking:
${order.trackingNumber || "None"}

Admin notes:
${notes}`,

      getAdminOrderButtons(
        order
      )
    );
  }

  /* =======================================================
     ORDER LIST
     ======================================================= */

  async function showOrderList(
    chatId,
    title,
    list
  ) {
    if (
      !list.length
    ) {
      return safeSendMessage(
        chatId,

`${title}

Nothing here.`,

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
        .slice(
          0,
          20
        )
        .map(
          order => [
            {
              text:
                `#${order.orderId} • ${order.customerName} • ${money(
                  order.totalPence
                )}`,

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

`${title}

Tap an order to manage it.`,

      {
        reply_markup: {
          inline_keyboard:
            buttons
        }
      }
    );
  }

  /* =======================================================
     SALES REPORTS
     ======================================================= */

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
      [
        ...orders.values()
      ]
        .filter(
          order => {
            const created =
              new Date(
                order.createdAt ||
                0
              )
                .getTime();

            return (
              Number.isFinite(
                created
              ) &&
              created >=
                startTime
            );
          }
        );

    const paid =
      selected.filter(
        order =>
          order.paymentStatus ===
          "paid"
      );

    let revenuePence =
      0;

    let shippingPence =
      0;

    let discountsPence =
      0;

    let unitsPaid =
      0;

    const sales =
      new Map();

    for (
      const order
      of paid
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

      discountsPence +=
        Number(
          order.discountPence ||
          0
        );

      for (
        const item
        of order.items ||
        []
      ) {
        const qty =
          Number(
            item.quantity ||
            0
          );

        unitsPaid +=
          qty;

        const key =
          Number(
            item.id
          );

        if (
          !sales.has(
            key
          )
        ) {
          sales.set(
            key,
            {
              name:
                item.name,

              units:
                0,

              salesPence:
                0
            }
          );
        }

        const stat =
          sales.get(
            key
          );

        stat.units +=
          qty;

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
      [
        ...sales.values()
      ]
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
${product.units} sold • ${money(
  product.salesPence
)}`
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
${money(
  revenuePence
)}

Average paid order:
${money(
  average
)}

Shipping collected:
${money(
  shippingPence
)}

Discounts:
${money(
  discountsPence
)}

Units sold:
${unitsPaid}

PRODUCT SALES

${
  productLines ||
  "No paid sales in this period."
}`
    );
  }

  /* =======================================================
     REVIEWS ADMIN
     ======================================================= */

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

    if (
      !pending.length
    ) {
      return safeSendMessage(
        chatId,

`⭐ Reviews

No reviews are waiting for approval.`,

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

  /* =======================================================
     STOCK CENTRE
     ======================================================= */

  async function showStockCentre(
    chatId
  ) {
    const live =
      getLiveProducts();

    const low =
      live.filter(
        product => {
          const stock =
            Number(
              product.stock
            );

          return (
            Number.isFinite(
              stock
            ) &&
            stock > 0 &&
            stock <=
              LOW_STOCK_THRESHOLD
          );
        }
      );

    const out =
      live.filter(
        product =>
          Number(
            product.stock
          ) ===
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

`${title}

${
  lines ||
  "Nothing here."
}`
    );
  }

  /* =======================================================
     SET TELEGRAM COMMANDS FOR ALL ADMINS
     ======================================================= */

  try {
    await bot.setMyCommands([
      {
        command:
          "start",

        description:
          "Open Kage Supps"
      },

      {
        command:
          "myid",

        description:
          "Show your Telegram ID"
      }
    ]);

    for (
      const adminId
      of adminTelegramIds
    ) {
      await bot.setMyCommands(
        [
          {
            command:
              "admin",

            description:
              "Open admin dashboard"
          },

          {
            command:
              "summary",

            description:
              "7 day shop summary"
          },

          {
            command:
              "reviews",

            description:
              "Pending reviews"
          },

          {
            command:
              "earnings",

            description:
              "Y8 earnings"
          },

          {
            command:
              "paid",

            description:
              "Mark order paid"
          },

          {
            command:
              "tracking",

            description:
              "Add tracking"
          },

          {
            command:
              "start",

            description:
              "Open main menu"
          },

          {
            command:
              "myid",

            description:
              "Show Telegram ID"
          }
        ],

        {
          scope: {
            type:
              "chat",

            chat_id:
              Number(
                adminId
              )
          }
        }
      );
    }

  } catch (err) {
    console.error(
      "SET COMMANDS ERROR:",
      err?.message ||
      err
    );
  }

  /* =======================================================
     /START
     ======================================================= */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,

    async msg => {
      const buttons =
        [];

      if (
        webAppUrl
      ) {
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

`⚡️ Welcome

🛍 Open Shop
📦 My Orders
💬 Support
ℹ️ Info${
  isAdmin(
    msg.from?.id
  )
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

      const earnings =
        referralEarnings.get(
          Y8_CODE
        );

      return safeSendMessage(
        msg.chat.id,

`💰 Y8 Earnings

Owner:
${Y8_OWNER}

Current balance:
${money(
  earnings?.balancePence ||
  0
)}

Lifetime earned:
${money(
  earnings?.totalEarnedPence ||
  0
)}

Paid out:
${money(
  earnings?.paidOutPence ||
  0
)}`
      );
    }
  );

  /* =======================================================
     /PAID
     ======================================================= */

  bot.onText(
    /^\/paid\s+(\d+)$/i,

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
        Number(
          match[1]
        );

      const order =
        orders.get(
          orderId
        );

      if (
        !order
      ) {
        return safeSendMessage(
          msg.chat.id,

          `❌ Order #${orderId} not found.`
        );
      }

      const result =
        await markOrderPaid(
          order
        );

      if (
        !result.ok
      ) {
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

Stock has been updated.`
      );
    }
  );

  /* =======================================================
     /TRACKING
     ======================================================= */

  bot.onText(
    /^\/tracking\s+(\d+)\s+(.+)$/i,

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
        Number(
          match[1]
        );

      const trackingNumber =
        String(
          match[2]
        ).trim();

      const order =
        orders.get(
          orderId
        );

      if (
        !order
      ) {
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
        new Date()
          .toISOString();

      saveOrder(
        order
      );

      await safeSendMessage(
        msg.chat.id,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${trackingNumber}`
      );

      if (
        order.telegramId
      ) {
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
        [
          ...orders.values()
        ]
          .filter(
            order => {
              const created =
                new Date(
                  order.createdAt ||
                  0
                )
                  .getTime();

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

      let revenuePence =
        0;

      let shippingPence =
        0;

      let discountsPence =
        0;

      let storeCreditPence =
        0;

      let unitsOrdered =
        0;

      let unitsPaid =
        0;

      const productStats =
        new Map();

      function statFor(
        id,
        name
      ) {
        const key =
          Number(
            id
          );

        if (
          !productStats.has(
            key
          )
        ) {
          productStats.set(
            key,

            {
              name:
                name ||
                `Product ${key}`,

              ordered:
                0,

              paid:
                0,

              revenuePence:
                0,

              basketAdds:
                0,

              basketRemoves:
                0
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
          Number(
            order.discountPence ||
            0
          );

        storeCreditPence +=
          Number(
            order.storeCreditPence ||
            0
          );

        for (
          const item
          of order.items ||
          []
        ) {
          const qty =
            Number(
              item.quantity ||
              0
            );

          statFor(
            item.id,
            item.name
          ).ordered +=
            qty;

          unitsOrdered +=
            qty;
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
            of order.items ||
            []
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

            stat.paid +=
              qty;

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

            unitsPaid +=
              qty;
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
          GROUP BY
            productId,
            action
        `).all(
          sinceIso
        );

      let basketAdds =
        0;

      let basketRemoves =
        0;

      for (
        const row
        of cartRows
      ) {
        const product =
          productsById.get(
            Number(
              row.productId
            )
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
        [
          ...productStats.values()
        ]
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
Sales: ${money(
  p.revenuePence
)}
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
${money(
  revenuePence
)}

Shipping collected:
${money(
  shippingPence
)}

Discounts:
${money(
  discountsPence
)}

Store credit used:
${money(
  storeCreditPence
)}

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

${
  productLines ||
  "No activity in the last 7 days."
}`
      );
    }
  );

  /* =========================================================
     CALLBACK QUERY HANDLER
     ========================================================= */

  bot.on(
    "callback_query",

    async q => {
      const chatId =
        q.message?.chat?.id;

      if (
        !chatId
      ) {
        return;
      }

      const data =
        String(
          q.data ||
          ""
        );

      /* =====================================================
         REVIEW APPROVE
         ===================================================== */

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
          ).get(
            reviewId
          );

        if (
          !review
        ) {
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
        ).run(
          reviewId
        );

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

      /* =====================================================
         REVIEW REJECT
         ===================================================== */

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
          ).get(
            reviewId
          );

        if (
          !review
        ) {
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
        ).run(
          reviewId
        );

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

      /* =====================================================
         ADMIN DASHBOARD
         ===================================================== */

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

      /* =====================================================
         RECENT ORDERS
         ===================================================== */

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

          getRecentOrders(
            15
          )
        );
      }

      /* =====================================================
         PAYMENT QUEUE
         ===================================================== */

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
          getRecentOrders(
            100
          )
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

      /* =====================================================
         DISPATCH QUEUE
         ===================================================== */

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
          getRecentOrders(
            100
          )
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

      /* =====================================================
         FIND ORDER
         ===================================================== */

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

        clearAdminInputs(
          chatId
        );

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

      /* =====================================================
         SALES REPORT MENU
         ===================================================== */

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

      /* =====================================================
         STOCK CENTRE
         ===================================================== */

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
                  Number.isFinite(
                    stock
                  ) &&
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
                ) ===
                0
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

        clearAdminInputs(
          chatId
        );

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

      /* =====================================================
         ADMIN REVIEWS
         ===================================================== */

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

      /* =====================================================
         Y8 EARNINGS
         ===================================================== */

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

        const earnings =
          referralEarnings.get(
            Y8_CODE
          );

        return safeSendMessage(
          chatId,

`💰 Y8 Earnings

Owner:
${Y8_OWNER}

Current balance:
${money(
  earnings?.balancePence ||
  0
)}

Lifetime earned:
${money(
  earnings?.totalEarnedPence ||
  0
)}

Paid out:
${money(
  earnings?.paidOutPence ||
  0
)}`,

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

      /* =====================================================
         OPEN ADMIN ORDER
         ===================================================== */

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
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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

      /* =====================================================
         MARK PAID BUTTON
         ===================================================== */

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
          orders.get(
            orderId
          );

        if (
          !order
        ) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        const result =
          await markOrderPaid(
            order
          );

        if (
          !result.ok
        ) {
          return safeSendMessage(
            chatId,

            `❌ ${result.error}`
          );
        }

        await safeSendMessage(
          chatId,

          result.alreadyPaid
            ? `ℹ️ Order #${orderId} was already paid.`
            : `✅ Order #${orderId} marked paid. Stock updated.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* =====================================================
         ADD TRACKING BUTTON
         ===================================================== */

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
          orders.get(
            orderId
          );

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

        clearAdminInputs(
          chatId
        );

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

      /* =====================================================
         ADMIN NOTE
         ===================================================== */

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
          !orders.has(
            orderId
          )
        ) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        clearAdminInputs(
          chatId
        );

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

      /* =====================================================
         SEND REVIEW LINK
         ===================================================== */

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
          orders.get(
            orderId
          );

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

        if (
          !order.telegramId
        ) {
          return safeSendMessage(
            chatId,

            "This order has no Telegram ID."
          );
        }

        const reviewUrl =
          getReviewUrl(
            order
          );

        if (
          !reviewUrl
        ) {
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

      /* =====================================================
         CONFIRM CANCELLATION

         IMPORTANT: this check MUST come before
         the general admin_cancel_ check.
         ===================================================== */

      if (
        data.startsWith(
          "admin_cancel_confirm_"
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
              "admin_cancel_confirm_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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

            "This order can no longer be cancelled from the dashboard."
          );
        }

        const creditRestored =
          restoreStoreCreditForOrder(
            order
          );

        order.paymentStatus =
          "cancelled";

        order.fulfilmentStatus =
          "cancelled";

        order.cancelledAt =
          new Date()
            .toISOString();

        order.cancelledBy =
          String(
            q.from?.id ||
            ""
          );

        saveOrder(
          order
        );

        if (
          order.telegramId
        ) {
          await safeSendMessage(
            order.telegramId,

`❌ Order cancelled

Order:
#${orderId}

${
  creditRestored
    ? `Store credit restored:
${money(
  order.storeCreditPence
)}

`
    : ""
}If you believe this was a mistake, please contact support.`
          );
        }

        await safeSendMessage(
          chatId,

`❌ Order #${orderId} cancelled.${
  creditRestored
    ? `

Store credit restored:
${money(
  order.storeCreditPence
)}`
    : ""
}`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* =====================================================
         CANCEL ORDER
         ===================================================== */

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
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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

This will mark the order as cancelled.

${
  Number(
    order.storeCreditPence ||
    0
  ) > 0
    ? `Store credit of ${money(
        order.storeCreditPence
      )} will be restored automatically.`
    : "No store credit was used."
}`,

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

      /* =====================================================
         MY ORDERS
         ===================================================== */

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
          [
            ...orders.values()
          ]
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
            .slice(
              0,
              10
            );

        if (
          !matches.length
        ) {
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
                `${money(
                  order.totalPence
                )} — ` +
                `${getOrderStatusText(
                  order
                )}` +
                tracking
              );
            }
          );

        return safeSendMessage(
          chatId,

`📦 My Orders

${lines.join(
  "\n\n"
)}`
        );
      }

      /* =====================================================
         SUPPORT
         ===================================================== */

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

        pendingSupport.add(
          chatId
        );

        return safeSendMessage(
          chatId,

`💬 Support

Send your message below.`
        );
      }

      /* =====================================================
         INFO
         ===================================================== */

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

  /* =========================================================
     MESSAGE INPUT HANDLER
     ========================================================= */

  bot.on(
    "message",

    async msg => {
      const chatId =
        msg.chat?.id;

      if (
        !chatId ||
        !msg.text ||
        msg.text.startsWith(
          "/"
        )
      ) {
        return;
      }

      const text =
        String(
          msg.text
        ).trim();

      /* =====================================================
         ADMIN FIND ORDER INPUT
         ===================================================== */

      if (
        pendingAdminOrderLookup.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
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
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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

      /* =====================================================
         ADMIN TRACKING INPUT
         ===================================================== */

      if (
        pendingAdminTracking.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {
        const orderId =
          pendingAdminTracking.get(
            chatId
          );

        pendingAdminTracking.delete(
          chatId
        );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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
          new Date()
            .toISOString();

        saveOrder(
          order
        );

        await safeSendMessage(
          chatId,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${text}`
        );

        if (
          order.telegramId
        ) {
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

      /* =====================================================
         ADMIN NOTE INPUT
         ===================================================== */

      if (
        pendingAdminNote.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {
        const orderId =
          pendingAdminNote.get(
            chatId
          );

        pendingAdminNote.delete(
          chatId
        );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {
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
          order.adminNotes =
            [];
        }

        order.adminNotes.push({
          text:
            text.slice(
              0,
              1000
            ),

          createdAt:
            new Date()
              .toISOString(),

          adminTelegramId:
            String(
              msg.from?.id ||
              ""
            )
        });

        saveOrder(
          order
        );

        await safeSendMessage(
          chatId,

          `✅ Note added to order #${orderId}.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* =====================================================
         STOCK ADJUSTMENT INPUT
         ===================================================== */

      if (
        pendingStockAdjustment.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
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

          if (
            !product
          ) {
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
${getLiveStock(
  productId
)}

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
            Number(
              text
            );

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

${
  product?.name ||
  `Product #${state.productId}`
}

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

      /* =====================================================
         SUPPORT MESSAGE
         ===================================================== */

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

    if (
      res.headersSent
    ) {
      return next(
        err
      );
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
      `Admins configured: ${adminTelegramIds.length}`
    );

    console.log(
      `Primary admin configured: ${Boolean(
        primaryAdminTelegramId
      )}`
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
      `Y8 discount: ${Y8_DISCOUNT_PERCENT}%`
    );

    console.log(
      `Y8 commission: ${Y8_COMMISSION_PERCENT}%`
    );

    console.log(
      `Y8 owner: ${Y8_OWNER}`
    );
  }
);