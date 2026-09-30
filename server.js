import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = Number(process.env.PORT || 3000);

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN;
const etherscanApiKey = process.env.ETHERSCAN;
const receivingAddress = process.env.ETH_RECEIVING_ADDRESS;
const webAppUrl = process.env.WEBAPP_URL;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;

const DATA_DIR = process.env.DATA_DIR || ".";

const supportTelegramIds = (process.env.SUPPORT_TELEGRAM_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

/* =========================================================
   SETTINGS
   ========================================================= */

const MINIMUM_ORDER_PENCE = 5000; // £50

const REFERRAL_DISCOUNT_PERCENT = 10;
const REFERRAL_COMMISSION_PERCENT = 5;

const LOYALTY_ORDER_THRESHOLD = 10;

const WEEKLY_SUMMARY_MS =
  7 * 24 * 60 * 60 * 1000;

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================================================
   DATABASE
   ========================================================= */

mkdirSync(DATA_DIR, {
  recursive: true
});

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

CREATE TABLE IF NOT EXISTS code_usage (
  code TEXT NOT NULL,
  buyerKey TEXT NOT NULL,
  PRIMARY KEY (code, buyerKey)
);

CREATE TABLE IF NOT EXISTS buyer_stats (
  buyerKey TEXT PRIMARY KEY,
  paidOrderCount INTEGER NOT NULL DEFAULT 0,
  telegramId TEXT,
  telegramUsername TEXT,
  ownReferralCode TEXT
);
`);

/* =========================================================
   PREPARED STATEMENTS
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
INSERT INTO cart_events
(productId, action, createdAt)
VALUES (?, ?, ?)
`);

const getBuyerStatsStmt = db.prepare(`
SELECT *
FROM buyer_stats
WHERE buyerKey = ?
`);

const upsertBuyerStatsStmt = db.prepare(`
INSERT INTO buyer_stats
(
  buyerKey,
  paidOrderCount,
  telegramId,
  telegramUsername,
  ownReferralCode
)
VALUES (?, ?, ?, ?, ?)

ON CONFLICT(buyerKey)
DO UPDATE SET
  paidOrderCount = excluded.paidOrderCount,
  telegramId = excluded.telegramId,
  telegramUsername = excluded.telegramUsername,
  ownReferralCode = excluded.ownReferralCode
`);

const hasCodeUsageStmt = db.prepare(`
SELECT 1
FROM code_usage
WHERE code = ?
AND buyerKey = ?
`);

const insertCodeUsageStmt = db.prepare(`
INSERT OR IGNORE INTO code_usage
(code, buyerKey)
VALUES (?, ?)
`);

/* =========================================================
   PRODUCTS
   ========================================================= */

const products = JSON.parse(
  readFileSync(
    path.join(__dirname, "public", "products.json"),
    "utf8"
  )
);

const productsById = new Map(
  products.map(product => [
    Number(product.id),
    product
  ])
);

/* =========================================================
   IN-MEMORY DATA
   ========================================================= */

const orders = new Map();
const discountCodes = new Map();
const referralEarnings = new Map();

let nextOrderId = 1001;

/* =========================================================
   LOAD DATABASE
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
  } catch (err) {
    console.error(
      "Invalid stored order:",
      row.id,
      err
    );
  }
}

for (
  const row of db
    .prepare(
      "SELECT code, json FROM discount_codes"
    )
    .all()
) {
  try {
    discountCodes.set(
      row.code,
      JSON.parse(row.json)
    );
  } catch {}
}

for (
  const row of db
    .prepare(
      "SELECT code, json FROM referral_earnings"
    )
    .all()
) {
  try {
    referralEarnings.set(
      row.code,
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

function getMeta(key) {
  const row = db
    .prepare(
      "SELECT value FROM meta WHERE key = ?"
    )
    .get(key);

  return row?.value || null;
}

function setMeta(key, value) {
  upsertMetaStmt.run(
    key,
    String(value)
  );
}

function money(pence) {
  return `£${(
    Number(pence) / 100
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

function buyerKeyFor({
  telegramId,
  telegramUsername
}) {
  if (telegramId) {
    return `id:${telegramId}`;
  }

  const username =
    normaliseUsername(
      telegramUsername
    );

  return username
    ? `user:${username}`
    : null;
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

  return Boolean(a && b && a === b);
}

function recordCartEvent(
  productId,
  action
) {
  insertCartEventStmt.run(
    Number(productId),
    action,
    new Date().toISOString()
  );
}

function getBuyerStats(buyerKey) {
  return (
    getBuyerStatsStmt.get(
      buyerKey
    ) || {
      buyerKey,
      paidOrderCount: 0,
      telegramId: null,
      telegramUsername: null,
      ownReferralCode: null
    }
  );
}

function saveBuyerStats(stats) {
  upsertBuyerStatsStmt.run(
    stats.buyerKey,
    Number(
      stats.paidOrderCount || 0
    ),
    stats.telegramId != null
      ? String(stats.telegramId)
      : null,
    stats.telegramUsername || null,
    stats.ownReferralCode || null
  );
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

function generateReferralCode(owner) {
  const cleaned = String(
    owner || "FRIEND"
  )
    .replace(
      /[^a-zA-Z0-9_]/g,
      ""
    )
    .toUpperCase()
    .slice(0, 18);

  return cleaned || "FRIEND";
}

function getOrCreateReferralCode(
  owner
) {
  let base =
    generateReferralCode(owner);

  let code = base;
  let suffix = 1;

  while (
    discountCodes.has(code) &&
    discountCodes.get(code)
      ?.referralOwner !== owner
  ) {
    code = `${base}${suffix}`;
    suffix += 1;
  }

  if (!discountCodes.has(code)) {
    saveDiscountCode(
      code,
      {
        discountType: "percent",
        discountValue:
          REFERRAL_DISCOUNT_PERCENT,
        referralOwner: owner,
        commissionPercent:
          REFERRAL_COMMISSION_PERCENT,
        uses: 0,
        active: true
      }
    );
  }

  if (
    !referralEarnings.has(code)
  ) {
    saveReferralEarnings(
      code,
      {
        code,
        balancePence: 0,
        totalEarnedPence: 0
      }
    );
  }

  return code;
}

function calculateDiscount(
  subtotalPence,
  record
) {
  if (!record) return 0;

  if (
    record.discountType ===
    "percent"
  ) {
    return Math.min(
      subtotalPence,
      Math.round(
        subtotalPence *
          (Number(
            record.discountValue
          ) /
            100)
      )
    );
  }

  return Math.min(
    subtotalPence,
    Number(
      record.discountValue || 0
    )
  );
}

/* =========================================================
   TELEGRAM
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
    "TELEGRAM environment variable missing."
  );
}

async function safeSendMessage(
  chatId,
  message,
  options
) {
  if (!bot || !chatId) return;

  try {
    await bot.sendMessage(
      chatId,
      message,
      options
    );
  } catch (err) {
    console.error(
      "Telegram message failed:",
      err?.message || err
    );
  }
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      products: products.length,
      telegramConfigured:
        Boolean(token),
      paymentAddressConfigured:
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
      !productsById.has(
        productId
      ) ||
      ![
        "add",
        "remove"
      ].includes(action)
    ) {
      return res
        .status(400)
        .json({
          error:
            "Invalid cart event"
        });
    }

    recordCartEvent(
      productId,
      action
    );

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   DISCOUNT CODES
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

    const buyerKey =
      buyerKeyFor({
        telegramId:
          req.query.telegramId,
        telegramUsername:
          req.query
            .telegramUsername
      });

    if (
      buyerKey &&
      record.referralOwner
    ) {
      const owner =
        normaliseUsername(
          record.referralOwner
        );

      const buyer =
        normaliseUsername(
          req.query
            .telegramUsername
        );

      if (
        owner &&
        buyer &&
        owner === buyer
      ) {
        return res
          .status(400)
          .json({
            valid: false,
            error:
              "You can't use your own referral code."
          });
      }
    }

    res.json({
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
   REFERRAL CREDIT
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

    if (!record) {
      return res
        .status(404)
        .json({
          error:
            "Referral code not found."
        });
    }

    res.json({
      code,
      balancePence:
        Number(
          record.balancePence ||
            0
        ),
      totalEarnedPence:
        Number(
          record.totalEarnedPence ||
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
  async (req, res) => {
    try {
      const {
        customerName,
        telegramUsername,
        telegramId,
        address,
        items,
        discountCode,
        storeCreditCode
      } = req.body || {};

      if (
        !customerName ||
        !address ||
        !Array.isArray(items) ||
        !items.length
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

      for (
        const rawItem of items
      ) {
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

        const stock =
          product.stock;

        if (
          Number.isFinite(stock) &&
          quantity > stock
        ) {
          return res
            .status(400)
            .json({
              error:
                `Not enough stock for ${product.name}`
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
            .status(500)
            .json({
              error:
                `Invalid server price for ${product.name}`
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
              `Minimum order is ${money(
                MINIMUM_ORDER_PENCE
              )}.`
          });
      }

      /* -------------------------
         DISCOUNT
         ------------------------- */

      let discountPence = 0;
      let appliedDiscountCode =
        null;

      if (discountCode) {
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
          record.active !== false
        ) {
          discountPence =
            calculateDiscount(
              subtotalPence,
              record
            );

          appliedDiscountCode =
            code;
        }
      }

      /* -------------------------
         STORE CREDIT
         ------------------------- */

      let storeCreditPence = 0;
      let appliedCreditCode =
        null;

      if (storeCreditCode) {
        const code =
          normaliseCode(
            storeCreditCode
          );

        const credit =
          referralEarnings.get(
            code
          );

        if (credit) {
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
          }
        }
      }

      const totalPence =
        Math.max(
          0,
          subtotalPence -
            discountPence -
            storeCreditPence
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
          String(address).trim(),

        items:
          lineItems,

        subtotalPence,
        discountPence,
        storeCreditPence,
        totalPence,

        discountCode:
          appliedDiscountCode,

        storeCreditCode:
          appliedCreditCode,

        paymentStatus:
          totalPence === 0
            ? "paid"
            : "awaiting_payment",

        fulfilmentStatus:
          "not_shipped",

        transactionId: null,
        trackingNumber: null,
        shippedAt: null,

        createdAt:
          new Date().toISOString()
      };

      saveOrder(order);

      /* -------------------------
         ADMIN NOTIFICATION
         ------------------------- */

      const itemLines =
        lineItems
          .map(
            item =>
              `${item.quantity} × ${item.name}`
          )
          .join("\n");

      await safeSendMessage(
        adminTelegramId,
        `🧾 New Order

Order: #${orderId}
Customer: ${order.customerName}
Telegram: ${
          telegramUsername
            ? `@${normaliseUsername(
                telegramUsername
              )}`
            : "Not supplied"
        }

Items:
${itemLines}

Subtotal: ${money(
          subtotalPence
        )}
Discount: ${money(
          discountPence
        )}
Credit: ${money(
          storeCreditPence
        )}
Total: ${money(
          totalPence
        )}

Status: ${
          totalPence === 0
            ? "Paid ✅"
            : "Awaiting payment"
        }`
      );

      /* -------------------------
         RESPONSE EXPECTED BY APP.JS
         ------------------------- */

      const response = {
        ok: true,
        orderId,
        subtotalPence,
        discountPence,
        storeCreditPence,
        totalPence,
        status:
          order.paymentStatus
      };

      if (
        totalPence > 0 &&
        receivingAddress
      ) {
        /*
          Your frontend expects
          order.payment.

          USDT quote generation should
          come from a trusted server-side
          GBP/USDT rate source.

          Until that rate is available,
          do NOT pretend £1 = 1 USDT.
        */

        response.payment = {
          method: "crypto",
          network: "ERC-20",
          address:
            receivingAddress,

          quote: {
            USDT: "QUOTE_PENDING"
          },

          instructions:
            "Send the displayed USDT amount using Ethereum ERC-20 only, then enter the transaction hash."
        };
      }

      return res.json(
        response
      );
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
   GET ORDER STATUS
   ========================================================= */

app.get(
  "/api/orders/:id",
  (req, res) => {
    const order =
      orders.get(
        Number(
          req.params.id
        )
      );

    if (!order) {
      return res
        .status(404)
        .json({
          error:
            "Order not found"
        });
    }

    res.json({
      orderId:
        order.orderId,

      paymentStatus:
        order.paymentStatus,

      fulfilmentStatus:
        order.fulfilmentStatus ||
        "not_shipped",

      trackingNumber:
        order.trackingNumber ||
        null,

      shippedAt:
        order.shippedAt ||
        null,

      subtotalPence:
        order.subtotalPence,

      totalPence:
        order.totalPence
    });
  }
);

/* =========================================================
   PAYMENT CONFIRMATION
   ========================================================= */

/*
  IMPORTANT:

  Do not mark an order paid simply because
  the buyer supplied a transaction hash.

  A production implementation must verify
  the on-chain ERC-20 Transfer event,
  recipient address, token contract,
  amount, chain and successful receipt.

  This endpoint therefore FAILS CLOSED
  until verified receipt checking is
  connected.
*/

app.post(
  "/api/orders/:id/confirm-payment",
  async (req, res) => {
    const order =
      orders.get(
        Number(
          req.params.id
        )
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

    if (
      !etherscanApiKey ||
      !receivingAddress
    ) {
      return res
        .status(503)
        .json({
          error:
            "Payment verification isn't configured."
        });
    }

    /*
      Do NOT replace this with:

      order.paymentStatus = "paid"

      merely because the hash exists.

      The receipt and USDT Transfer log
      must be verified first.
    */

    return res
      .status(503)
      .json({
        error:
          "Automatic ERC-20 verification is not enabled on this build yet. The order remains awaiting payment."
      });
  }
);

/* =========================================================
   WEEKLY SUMMARY
   ========================================================= */

function buildActivitySummary(
  sinceIso
) {
  const recent =
    [...orders.values()]
      .filter(
        order =>
          order.createdAt >=
          sinceIso
      );

  const paid =
    recent.filter(
      order =>
        order.paymentStatus ===
        "paid"
    );

  const revenue =
    paid.reduce(
      (sum, order) =>
        sum +
        Number(
          order.totalPence ||
            0
        ),
      0
    );

  return (
    `Orders: ${recent.length}\n` +
    `Paid: ${paid.length}\n` +
    `Revenue: ${money(
      revenue
    )}`
  );
}

async function maybeSendWeeklySummary() {
  if (
    !bot ||
    !adminTelegramId
  ) {
    return;
  }

  const last =
    getMeta(
      "lastWeeklySummaryAt"
    );

  if (!last) {
    setMeta(
      "lastWeeklySummaryAt",
      new Date().toISOString()
    );

    return;
  }

  if (
    Date.now() -
      new Date(last).getTime() <
    WEEKLY_SUMMARY_MS
  ) {
    return;
  }

  const summary =
    buildActivitySummary(
      last
    );

  await safeSendMessage(
    adminTelegramId,
    `📊 Weekly Summary

${summary}`
  );

  setMeta(
    "lastWeeklySummaryAt",
    new Date().toISOString()
  );
}

/* =========================================================
   TELEGRAM COMMANDS
   ========================================================= */

const pendingSupport =
  new Set();

if (bot) {
  setInterval(
    () => {
      maybeSendWeeklySummary()
        .catch(console.error);
    },
    60 * 60 * 1000
  );

  maybeSendWeeklySummary()
    .catch(console.error);

  bot.onText(
    /\/myid/,
    async msg => {
      await safeSendMessage(
        msg.chat.id,
        `Your Telegram ID: ${msg.from.id}`
      );
    }
  );

  bot.onText(
    /\/summary/,
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

      const since =
        new Date(
          Date.now() -
            WEEKLY_SUMMARY_MS
        ).toISOString();

      await safeSendMessage(
        msg.chat.id,
        `📊 Last 7 Days

${buildActivitySummary(
  since
)}`
      );
    }
  );

  /* =======================================================
     TRACKING
     /tracking 1042 GB123456789GB
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
        match[2].trim();

      const order =
        orders.get(
          orderId
        );

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

      if (
        order.telegramId
      ) {
        await safeSendMessage(
          order.telegramId,
          `📦 Your order has been dispatched

Order: #${order.orderId}

Tracking:
${trackingNumber}

Use the tracking number with the relevant courier to follow your parcel.`
        );
      }

      await safeSendMessage(
        msg.chat.id,
        `✅ Tracking saved

Order: #${orderId}
Tracking: ${trackingNumber}`
      );
    }
  );
}

/* =========================================================
   START MENU
   ========================================================= */

if (
  bot &&
  webAppUrl
) {
  bot.onText(
    /\/start/,
    async msg => {
      await safeSendMessage(
        msg.chat.id,
        `⚡️ Welcome

🛍 Open Shop
📦 My Orders
💬 Support
ℹ️ Info`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "🛍 OPEN SHOP — TAP HERE",
                  web_app: {
                    url:
                      webAppUrl
                  }
                }
              ],
              [
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
              ],
              [
                {
                  text:
                    "ℹ️ Info",
                  callback_data:
                    "info"
                }
              ]
            ]
          }
        }
      );
    }
  );

  bot.on(
    "callback_query",
    async q => {
      const chatId =
        q.message?.chat?.id;

      if (!chatId) return;

      try {
        await bot
          .answerCallbackQuery(
            q.id
          );
      } catch {}

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
            .filter(order =>
              orderBelongsToViewer(
                order,
                viewer
              )
            )
            .sort(
              (a, b) =>
                new Date(
                  b.createdAt
                ) -
                new Date(
                  a.createdAt
                )
            )
            .slice(0, 10);

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
                order
                  .fulfilmentStatus ===
                "shipped"
              ) {
                status =
                  "Shipped 📦";
              } else if (
                order
                  .paymentStatus ===
                "paid"
              ) {
                status =
                  "Paid ✅ — awaiting dispatch";
              }

              const date =
                new Date(
                  order.createdAt
                ).toLocaleDateString(
                  "en-GB"
                );

              const tracking =
                order.trackingNumber
                  ? `\nTracking: ${order.trackingNumber}`
                  : "";

              return (
                `#${order.orderId} — ` +
                `${money(
                  order.totalPence
                )} — ` +
                `${status} (${date})` +
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

      if (
        q.data ===
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

Send your message below and our team will get it.`
        );
      }

      if (
        q.data ===
        "info"
      ) {
        return safeSendMessage(
          chatId,
          `ℹ️ Info

Tap Open Shop to launch the Mini App.`
        );
      }
    }
  );

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

      const text =
        `💬 New Support Message

From: ${from}

Message:
${msg.text}`;

      for (
        const supportId of
        supportTelegramIds
      ) {
        await safeSendMessage(
          supportId,
          text
        );
      }

      await safeSendMessage(
        chatId,
        "Thanks — your message has been sent to our support team."
      );
    }
  );
}

/* =========================================================
   ERROR HANDLER
   ========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "UNHANDLED SERVER ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    res
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
      `Products loaded: ${products.length}`
    );

    console.log(
      `Telegram: ${
        token
          ? "configured"
          : "missing"
      }`
    );

    console.log(
      `Receiving address: ${
        receivingAddress
          ? "configured"
          : "missing"
      }`
    );
  }
);