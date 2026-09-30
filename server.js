import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const app = express();
const port = Number(process.env.PORT || 3000);

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN;

const etherscanApiKey =
  process.env.ETHERSCAN ||
  process.env.ETHERSCAN_API_KEY;

const receivingAddress =
  process.env.ETH_RECEIVING_ADDRESS;

const usdtContractAddress =
  process.env.USDT_CONTRACT_ADDRESS ||
  "0xdAC17F958D2ee523a2206206994597C13D831ec7";

const webAppUrl =
  process.env.WEBAPP_URL;

const adminTelegramId =
  process.env.ADMIN_TELEGRAM_ID;

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
   SETTINGS
   ========================================================= */

const MINIMUM_ORDER_PENCE = 5000; // £50

const REFERRAL_DISCOUNT_PERCENT = 10;
const REFERRAL_COMMISSION_PERCENT = 5;

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
`);

/* =========================================================
   PREPARED STATEMENTS
   ========================================================= */

const upsertOrderStmt =
  db.prepare(`
    INSERT INTO orders (id, json)
    VALUES (?, ?)

    ON CONFLICT(id)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertDiscountStmt =
  db.prepare(`
    INSERT INTO discount_codes (code, json)
    VALUES (?, ?)

    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertReferralStmt =
  db.prepare(`
    INSERT INTO referral_earnings (code, json)
    VALUES (?, ?)

    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertMetaStmt =
  db.prepare(`
    INSERT INTO meta (key, value)
    VALUES (?, ?)

    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value
  `);

const insertCartEventStmt =
  db.prepare(`
    INSERT INTO cart_events
    (
      productId,
      action,
      createdAt
    )
    VALUES (?, ?, ?)
  `);

/* =========================================================
   PRODUCTS
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
   IN-MEMORY DATA
   ========================================================= */

const orders =
  new Map();

const discountCodes =
  new Map();

const referralEarnings =
  new Map();

let nextOrderId = 1001;

/* =========================================================
   LOAD DATABASE
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
      JSON.parse(row.json)
    );
  } catch {}
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

const savedNextOrderId =
  db
    .prepare(
      "SELECT value FROM meta WHERE key = ?"
    )
    .get(
      "nextOrderId"
    );

if (savedNextOrderId) {
  nextOrderId =
    Number(
      savedNextOrderId.value
    ) ||
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
  nextOrderId =
    value;

  upsertMetaStmt.run(
    "nextOrderId",
    String(value)
  );
}

function money(pence) {
  return `£${(
    Number(pence || 0) /
    100
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

function normaliseAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
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
      Number(totalPence) /
      100;

    const usdt =
      pounds /
      gbpPerUsdt;

    return usdt.toFixed(2);

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
          "TELEGRAM BOT ERROR:",
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
      "Telegram message failed:",
      err?.response?.body ||
      err?.message ||
      err
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

      products:
        products.length,

      telegramConfigured:
        Boolean(token),

      webAppConfigured:
        Boolean(webAppUrl),

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
      ].includes(action)
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
   DISCOUNT CODE
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
   REFERRAL BALANCE
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

    return res.json({
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

      /* =====================================================
         EVERY PRODUCT IS AVAILABLE FOR CHECKOUT
         AS LONG AS:
         - product exists
         - stock is available
         - pricePence is valid
         ===================================================== */

      for (
        const rawItem of items
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

        /* STOCK */

        const stock =
          Number(
            product.stock
          );

        if (
          Number.isFinite(
            stock
          ) &&
          quantity >
            stock
        ) {
          return res
            .status(400)
            .json({
              error:
                `Not enough stock for ${product.name}`
            });
        }

        /* PRICE */

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
         ===================================================== */

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

      /* =====================================================
         DISCOUNT
         ===================================================== */

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

      /* =====================================================
         STORE CREDIT
         ===================================================== */

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

      /* =====================================================
         PAYMENT QUOTE
         ===================================================== */

      let usdtQuote =
        null;

      if (
        totalPence > 0
      ) {
        usdtQuote =
          await getUsdtQuote(
            totalPence
          );
      }

      /* =====================================================
         ORDER ID
         ===================================================== */

      const orderId =
        nextOrderId;

      saveNextOrderId(
        nextOrderId + 1
      );

      /* =====================================================
         SAVE ORDER
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

        quotedUsdt:
          usdtQuote,

        transactionId:
          null,

        trackingNumber:
          null,

        shippedAt:
          null,

        createdAt:
          new Date()
            .toISOString()
      };

      saveOrder(order);

      /* =====================================================
         ADMIN MESSAGE
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

        `🧾 New Order

Order: #${orderId}

Customer:
${order.customerName}

Telegram:
${
  telegramUsername
    ? `@${normaliseUsername(
        telegramUsername
      )}`
    : "Not supplied"
}

Items:
${itemLines}

Subtotal:
${money(subtotalPence)}

Discount:
${money(discountPence)}

Credit:
${money(storeCreditPence)}

Total:
${money(totalPence)}

Status:
${
  totalPence === 0
    ? "Paid ✅"
    : "Awaiting payment"
}`
      );

      /* =====================================================
         FRONT END RESPONSE
         ===================================================== */

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

      /*
        This is deliberately in the shape
        your app.js was expecting:

        order.payment.address
        order.payment.quote.USDT
      */

      if (
        totalPence > 0 &&
        receivingAddress
      ) {
        response.payment = {
          method:
            "crypto",

          network:
            "ERC-20",

          address:
            receivingAddress,

          quote: {
            USDT:
              usdtQuote
          },

          instructions:
            usdtQuote
              ? `Send ${usdtQuote} USDT using Ethereum ERC-20 only, then enter the transaction hash.`
              : "Payment quote is temporarily unavailable. Please try checkout again shortly."
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
   GET ORDER
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

    return res.json({
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
        order.totalPence,

      quotedUsdt:
        order.quotedUsdt ||
        null
    });
  }
);

/* =========================================================
   SUBMIT TRANSACTION HASH
   ========================================================= */

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

    /* Prevent one TX being used twice */

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

    if (alreadyUsed) {
      return res
        .status(400)
        .json({
          error:
            "That transaction has already been used."
        });
    }

    /*
      Save the submitted hash.

      It is NOT marked paid merely because
      a hash was supplied.
    */

    order.transactionId =
      transactionId;

    order.paymentStatus =
      "payment_submitted";

    saveOrder(order);

    await safeSendMessage(
      adminTelegramId,

      `💳 Payment submitted

Order:
#${order.orderId}

Transaction:
${transactionId}

Expected:
${
  order.quotedUsdt
    ? `${order.quotedUsdt} USDT`
    : money(
        order.totalPence
      )
}`
    );

    return res.json({
      ok: true,

      orderId:
        order.orderId,

      status:
        "payment_submitted",

      message:
        "Transaction submitted for confirmation."
    });
  }
);

/* =========================================================
   TELEGRAM MENU
   ========================================================= */

const pendingSupport =
  new Set();

if (bot) {

  /* START */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,

    async msg => {

      const buttons =
        [];

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

  /* MY ID */

  bot.onText(
    /^\/myid(?:@\w+)?$/i,

    async msg => {
      await safeSendMessage(
        msg.chat.id,

        `Your Telegram ID: ${msg.from.id}`
      );
    }
  );

  /* MARK ORDER PAID */

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

      if (!order) {
        return safeSendMessage(
          msg.chat.id,

          `❌ Order #${orderId} not found.`
        );
      }

      order.paymentStatus =
        "paid";

      order.paidAt =
        new Date()
          .toISOString();

      saveOrder(order);

      await safeSendMessage(
        msg.chat.id,

        `✅ Order #${orderId} marked paid.`
      );

      if (
        order.telegramId
      ) {
        await safeSendMessage(
          order.telegramId,

          `✅ Payment confirmed

Order:
#${orderId}

Your order is now awaiting dispatch.`
        );
      }
    }
  );

  /* TRACKING */

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
        new Date()
          .toISOString();

      saveOrder(order);

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

  /* CALLBACKS */

  bot.on(
    "callback_query",

    async q => {

      const chatId =
        q.message?.chat?.id;

      if (!chatId) {
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
              (a, b) =>
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
                  "Paid ✅ — awaiting dispatch";
              }

              else if (
                order.paymentStatus ===
                "payment_submitted"
              ) {
                status =
                  "Payment submitted ⏳";
              }

              const date =
                order.createdAt
                  ? new Date(
                      order.createdAt
                    )
                      .toLocaleDateString(
                        "en-GB"
                      )
                  : "Unknown";

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

      /* SUPPORT */

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

      /* INFO */

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

  /* SUPPORT FORWARDING */

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

      const message =
        `💬 New Support Message

From:
${from}

Message:
${msg.text}`;

      for (
        const supportId of
        supportTelegramIds
      ) {
        await safeSendMessage(
          supportId,
          message
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
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      "UNHANDLED SERVER ERROR:",
      err
    );

    if (
      res.headersSent
    ) {
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
      `WEBAPP_URL: ${
        webAppUrl
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

    console.log(
      "Checkout: enabled for every valid product"
    );
  }
);