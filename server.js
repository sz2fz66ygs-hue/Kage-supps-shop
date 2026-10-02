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

const adminTelegramId =
  process.env.ADMIN_TELEGRAM_ID || "";

const DATA_DIR =
  process.env.DATA_DIR || ".";

const supportTelegramIds =
  (
    process.env.SUPPORT_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

/* =========================================================
   SHOP SETTINGS
   ========================================================= */

// Basket must reach £50 BEFORE discounts.
const MINIMUM_ORDER_PENCE = 5000;

// £5 delivery charge added AFTER discounts.
const SHIPPING_PENCE = 500;

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

/*
  products.json supplies the STARTING stock.

  SQLite then becomes the live stock count.

  INSERT OR IGNORE means restarting or redeploying
  will NOT reset stock that has already been sold.
*/

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
   IMPORTANT:
   SERVE LIVE STOCK AT /products.json

   Your existing app can keep fetching /products.json.
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

/* Static files come AFTER /products.json */

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
   Y8 CODE
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

  /*
    Check everything BEFORE changing anything.
  */

  for (
    const item
    of order.items
  ) {
    const liveStock =
      getLiveStock(
        item.id
      );

    /*
      null = product has no managed finite stock.
    */

    if (
      liveStock === null
    ) {
      continue;
    }

    if (
      liveStock <
      Number(item.quantity)
    ) {
      return {
        ok: false,

        error:
          `Not enough stock remaining for ${item.name}. Available: ${liveStock}.`
      };
    }
  }

  /*
    Now deduct all quantities.
  */

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
   TELEGRAM
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
    return;
  }

  try {
    await bot.sendMessage(
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

  /*
    Deduct stock ONCE.
  */

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

  /*
    Referral commission only becomes real
    once payment is confirmed.
  */

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

  /* =======================================================
     ADMIN PAID MESSAGE
     ======================================================= */

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

  /* =======================================================
     CUSTOMER PAID MESSAGE + REVIEW BUTTON
     ======================================================= */

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
        discountCodes.has(
          Y8_CODE
        ),

      y8Owner:
        Y8_OWNER,

      telegramConfigured:
        Boolean(
          token
        ),

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

  (req, res) => {
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

  (req, res) => {
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
          valid:
            false,

          error:
            "That code isn't valid."
        });
    }

    return res.json({
      valid:
        true,

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

  (req, res) => {
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
        req.body || {};

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

      /* =====================================================
         PRODUCTS + LIVE STOCK CHECK
         ===================================================== */

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

      /* =====================================================
         £50 MINIMUM

         CHECKED BEFORE:
         - Y8
         - OTHER DISCOUNTS
         - STORE CREDIT
         - SHIPPING
         ===================================================== */

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

      /* =====================================================
         DISCOUNT
         ===================================================== */

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

      /* =====================================================
         STORE CREDIT
         ===================================================== */

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

        /*
          Y8 is cash-only.
        */

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

      /* =====================================================
         TOTAL

         BASKET
         - DISCOUNT
         - STORE CREDIT
         + £5 SHIPPING
         ===================================================== */

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

      /* =====================================================
         PAYMENT QUOTE
         ===================================================== */

      const usdtQuote =
        await getUsdtQuote(
          totalPence
        );

      /* =====================================================
         ORDER ID
         ===================================================== */

      const orderId =
        nextOrderId;

      saveNextOrderId(
        nextOrderId +
        1
      );

      /* =====================================================
         ORDER
         ===================================================== */

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

        reviewToken:
          randomUUID(),

        createdAt:
          new Date()
            .toISOString()
      };

      saveOrder(
        order
      );

      /* =====================================================
         INITIAL ADMIN MESSAGE
         ===================================================== */

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

      /* =====================================================
         RESPONSE TO MINI APP
         ===================================================== */

      return res.json({
        ok:
          true,

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
        ok:
          true,

        alreadyPaid:
          true
      });
    }

    const transactionId =
      String(
        req.body
          ?.transactionId ||
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

    order.paymentStatus =
      "payment_submitted";

    saveOrder(
      order
    );

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
${money(
  order.totalPence
)}

Transaction:
${transactionId}

Use:
/paid ${order.orderId}

once payment has been confirmed.`
    );

    return res.json({
      ok:
        true,

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
      db
        .prepare(`
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
        `)
        .all();

    return res.json(
      rows
    );
  }
);

app.post(
  "/api/reviews",

  (req, res) => {
    const orderId =
      Number(
        req.body
          ?.orderId
      );

    const token =
      String(
        req.body
          ?.token ||
          ""
      );

    const rating =
      Number(
        req.body
          ?.rating
      );

    const displayName =
      String(
        req.body
          ?.displayName ||
          "Customer"
      )
        .trim()
        .slice(
          0,
          50
        );

    const reviewText =
      String(
        req.body
          ?.reviewText ||
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
      !token ||
      token !==
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

      new Date()
        .toISOString()
    );

    safeSendMessage(
      adminTelegramId,

      `⭐ NEW REVIEW

Order:
#${orderId}

Customer:
${displayName}

Rating:
${rating}/5

Review:
${reviewText}

The review is waiting for approval.`
    );

    return res.json({
      ok:
        true,

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

    const token =
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
      token !==
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
        token
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

const orderId =
  ${orderId};

const token =
  ${tokenJson};

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
   TELEGRAM
   ========================================================= */

const pendingSupport =
  new Set();

if (
  bot
) {

  /* =======================================================
     START
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

      await safeSendMessage(
        msg.chat.id,

        `⚡️ Welcome

🛍 Open Shop
📦 My Orders
💬 Support
ℹ️ Info`,

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
     MY ID
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
     Y8 EARNINGS
     ======================================================= */

  bot.onText(
    /^\/earnings(?:@\w+)?$/i,

    async msg => {
      if (
        !adminTelegramId ||
        String(
          msg.from?.id
        ) !==
        String(
          adminTelegramId
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
     MARK ORDER PAID

     THIS IS WHERE STOCK DROPS.
     ======================================================= */

  bot.onText(
    /^\/paid\s+(\d+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !adminTelegramId ||
        String(
          msg.from?.id
        ) !==
        String(
          adminTelegramId
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
     TRACKING
     ======================================================= */

  bot.onText(
    /^\/tracking\s+(\d+)\s+(.+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !adminTelegramId ||
        String(
          msg.from?.id
        ) !==
        String(
          adminTelegramId
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
     CALLBACKS
     ======================================================= */

  bot.on(
    "callback_query",

    async q => {
      const chatId =
        q.message
          ?.chat
          ?.id;

      if (
        !chatId
      ) {
        return;
      }

      try {
        await bot
          .answerCallbackQuery(
            q.id
          );
      } catch {}

      /* MY ORDERS */

      if (
        q.data ===
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
              let status =
                "Awaiting payment";

              if (
                order.fulfilmentStatus ===
                "shipped"
              ) {
                status =
                  "Shipped 📦";
              }

              else if (
                order.paymentStatus ===
                "paid"
              ) {
                status =
                  "Paid ✅";
              }

              else if (
                order.paymentStatus ===
                "payment_submitted"
              ) {
                status =
                  "Payment submitted ⏳";
              }

              const tracking =
                order.trackingNumber
                  ? `\nTracking: ${order.trackingNumber}`
                  : "";

              return (
                `#${order.orderId} — ` +
                `${money(
                  order.totalPence
                )} — ` +
                `${status}` +
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

      /* SUPPORT */

      if (
        q.data ===
        "support"
      ) {
        if (
          !supportTelegramIds
            .length
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

      /* INFO */

      if (
        q.data ===
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
     SUPPORT FORWARDING
     ======================================================= */

  bot.on(
    "message",

    async msg => {
      const chatId =
        msg.chat?.id;

      if (
        !chatId ||
        !pendingSupport.has(
          chatId
        )
      ) {
        return;
      }

      if (
        !msg.text ||
        msg.text.startsWith(
          "/"
        )
      ) {
        return;
      }

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
${msg.text}`
        );
      }

      await safeSendMessage(
        chatId,

        "Thanks — your message has been sent."
      );
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