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
   ENVIRONMENT
   ========================================================= */

const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN;

const receivingAddress =
  process.env.ETH_RECEIVING_ADDRESS;

const etherscanApiKey =
  process.env.ETHERSCAN ||
  process.env.ETHERSCAN_API_KEY;

const webAppUrl =
  process.env.WEBAPP_URL;

const adminTelegramId =
  process.env.ADMIN_TELEGRAM_ID;

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

const MINIMUM_ORDER_PENCE = 5000; // £50 BEFORE discount
const SHIPPING_PENCE = 500;       // £5 shipping

/* =========================================================
   Y8 REFERRAL
   ========================================================= */

const Y8_CODE = "Y8";
const Y8_OWNER = "@Y8_JKO";

const Y8_DISCOUNT_PERCENT = 10;
const Y8_COMMISSION_PERCENT = 5;

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
   DATABASE STATEMENTS
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
    INSERT INTO cart_events (
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
  products = JSON.parse(
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
      String(row.code).toUpperCase(),
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
      String(row.code).toUpperCase(),
      JSON.parse(row.json)
    );
  } catch {}
}

const savedNextOrderId =
  db
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

  const orderUsername =
    normaliseUsername(
      order.telegramUsername
    );

  const viewerUsername =
    normaliseUsername(
      viewer.telegramUsername
    );

  return Boolean(
    orderUsername &&
    viewerUsername &&
    orderUsername ===
      viewerUsername
  );
}

/* =========================================================
   SEED Y8
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

  const existing =
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

  existing.owner =
    existing.owner ||
    order.referralOwner ||
    null;

  existing.balancePence =
    Number(
      existing.balancePence ||
      0
    ) +
    Number(
      order.referralCommissionPence ||
      0
    );

  existing.totalEarnedPence =
    Number(
      existing.totalEarnedPence ||
      0
    ) +
    Number(
      order.referralCommissionPence ||
      0
    );

  saveReferralEarnings(
    code,
    existing
  );

  order.referralCredited =
    true;

  saveOrder(order);
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
      "Telegram send failed:",
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
        Boolean(token),

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

      const lineItems =
        [];

      let subtotalPence =
        0;

      /* PRODUCTS */

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

        const stock =
          Number(
            product.stock
          );

        if (
          Number.isFinite(
            stock
          ) &&
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
         £50 MINIMUM CHECK

         IMPORTANT:
         THIS HAPPENS BEFORE:
         - Y8 DISCOUNT
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

      if (storeCreditCode) {
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
          credit.cashOnly !== true
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
         FINAL TOTAL

         subtotal
         - discount
         - store credit
         + £5 shipping
         ===================================================== */

      const productsAfterDiscounts =
        Math.max(
          0,

          subtotalPence -
          discountPence -
          storeCreditPence
        );

      const shippingPence =
        SHIPPING_PENCE;

      const totalPence =
        productsAfterDiscounts +
        shippingPence;

      /* =====================================================
         USDT QUOTE
         ===================================================== */

      const usdtQuote =
        await getUsdtQuote(
          totalPence
        );

      /* =====================================================
         ORDER
         ===================================================== */

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
          String(address)
            .trim(),

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

        shippedAt:
          null,

        createdAt:
          new Date()
            .toISOString()
      };

      saveOrder(order);

      /* =====================================================
         ADMIN NOTIFICATION
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

Order:
#${orderId}

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

Total:
${money(
  totalPence
)}

${
  appliedDiscountCode
    ? `Code: ${appliedDiscountCode}`
    : ""
}

${
  referralCommissionPence
    ? `Referral owner: ${referralOwner}
Commission when paid: ${money(
        referralCommissionPence
      )}`
    : ""
}

Status:
Awaiting payment`
      );

      /* =====================================================
         FRONT-END RESPONSE
         ===================================================== */

      const response = {
        ok: true,

        orderId,

        subtotalPence,

        discountPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        status:
          order.paymentStatus
      };

      if (
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
              : "Payment quote unavailable. Please try again."
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
   ORDER STATUS
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
   PAYMENT HASH SUBMISSION
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

    saveOrder(order);

    await safeSendMessage(
      adminTelegramId,

      `💳 Payment submitted

Order:
#${order.orderId}

Expected:
${
  order.quotedUsdt
    ? `${order.quotedUsdt} USDT`
    : money(
        order.totalPence
      )
}

Transaction:
${transactionId}`
    );

    return res.json({
      ok: true,

      orderId:
        order.orderId,

      status:
        "payment_submitted"
    });
  }
);

/* =========================================================
   TELEGRAM MENU
   ========================================================= */

const pendingSupport =
  new Set();

if (bot) {

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

  /* EARNINGS */

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

  /* MARK PAID */

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

      const order =
        orders.get(
          Number(
            match[1]
          )
        );

      if (!order) {
        return safeSendMessage(
          msg.chat.id,
          "Order not found."
        );
      }

      order.paymentStatus =
        "paid";

      order.paidAt =
        new Date()
          .toISOString();

      saveOrder(order);

      if (
        order.referralCommissionPence >
          0 &&
        !order.referralCredited
      ) {
        creditReferralForOrder(
          order
        );
      }

      await safeSendMessage(
        msg.chat.id,

        `✅ Order #${order.orderId} marked paid.`
      );

      if (
        order.telegramId
      ) {
        await safeSendMessage(
          order.telegramId,

          `✅ Payment confirmed

Order:
#${order.orderId}

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

      const order =
        orders.get(
          Number(
            match[1]
          )
        );

      if (!order) {
        return safeSendMessage(
          msg.chat.id,
          "Order not found."
        );
      }

      if (
        order.paymentStatus !==
        "paid"
      ) {
        return safeSendMessage(
          msg.chat.id,
          "Order is not marked paid."
        );
      }

      order.trackingNumber =
        match[2].trim();

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
#${order.orderId}

Tracking:
${order.trackingNumber}`
      );

      if (
        order.telegramId
      ) {
        await safeSendMessage(
          order.telegramId,

          `📦 Your order has been dispatched

Order:
#${order.orderId}

Tracking:
${order.trackingNumber}`
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
                  "Paid ✅";
              }

              else if (
                order.paymentStatus ===
                "payment_submitted"
              ) {
                status =
                  "Payment submitted ⏳";
              }

              return (
                `#${order.orderId} — ` +
                `${money(
                  order.totalPence
                )} — ` +
                status
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

Send your message below.`
        );
      }

      if (
        q.data ===
        "info"
      ) {
        return safeSendMessage(
          chatId,

          `ℹ️ Info

Minimum basket: £50 before discount
Shipping: £5

Tap Open Shop to launch the Mini App.`
        );
      }
    }
  );

  /* SUPPORT */

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
        const supportId of
        supportTelegramIds
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
   START
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
      `Y8: ${Y8_DISCOUNT_PERCENT}% discount`
    );

    console.log(
      `Y8 commission: ${Y8_COMMISSION_PERCENT}%`
    );

    console.log(
      `Y8 owner: ${Y8_OWNER}`
    );
  }
);