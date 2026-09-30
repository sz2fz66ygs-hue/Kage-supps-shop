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

const webAppUrl = process.env.WEBAPP_URL;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
const DATA_DIR = process.env.DATA_DIR || ".";

const supportTelegramIds = (
  process.env.SUPPORT_TELEGRAM_IDS || ""
)
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

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
`);

/* =========================================================
   PRODUCTS
   ========================================================= */

const products = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      "public",
      "products.json"
    ),
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
   LOAD ORDERS
   ========================================================= */

const orders = new Map();

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

/* =========================================================
   HELPERS
   ========================================================= */

function money(pence) {
  return `£${(
    Number(pence || 0) / 100
  ).toFixed(2)}`;
}

function normaliseUsername(value) {
  return String(value || "")
    .replace(/^@/, "")
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
    "Telegram token missing. Set TELEGRAM or TELEGRAM_BOT_TOKEN in Render."
  );
}

/* =========================================================
   SAFE SEND
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
        Boolean(webAppUrl)
    });
  }
);

/* =========================================================
   TELEGRAM MENU
   ========================================================= */

const pendingSupport =
  new Set();

if (bot) {

  /* -------------------------
     START
     ------------------------- */

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

  /* -------------------------
     MY ID
     ------------------------- */

  bot.onText(
    /^\/myid(?:@\w+)?$/i,

    async msg => {

      await safeSendMessage(
        msg.chat.id,

        `Your Telegram ID: ${msg.from.id}`
      );
    }
  );

  /* -------------------------
     BUTTONS
     ------------------------- */

  bot.on(
    "callback_query",

    async q => {

      const chatId =
        q.message?.chat?.id;

      if (!chatId) {
        return;
      }

      try {
        await bot.answerCallbackQuery(
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
                  b.createdAt || 0
                ) -
                new Date(
                  a.createdAt || 0
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
              } else if (
                order.paymentStatus ===
                "paid"
              ) {
                status =
                  "Paid ✅ — awaiting dispatch";
              }

              const date =
                order.createdAt
                  ? new Date(
                      order.createdAt
                    ).toLocaleDateString(
                      "en-GB"
                    )
                  : "Unknown date";

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

${lines.join("\n\n")}`
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

${
  webAppUrl
    ? "Tap Open Shop to launch the Mini App."
    : "The Mini App URL isn't configured yet."
}`
        );
      }
    }
  );

  /* -------------------------
     SUPPORT MESSAGES
     ------------------------- */

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
   GENERIC CHECKOUT
   ========================================================= */

/*
  Checkout is available only for products
  explicitly marked:

  "purchasable": true

  in products.json.
*/

app.post(
  "/api/orders",

  async (req, res) => {

    try {

      const {
        customerName,
        telegramUsername,
        telegramId,
        address,
        items
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

        if (
          product.purchasable !==
          true
        ) {
          return res
            .status(400)
            .json({
              error:
                `${product.name} is not available for checkout.`
            });
        }

        if (
          Number.isFinite(
            product.stock
          ) &&
          quantity >
            product.stock
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

      const existingIds =
        [...orders.keys()];

      const highestId =
        existingIds.length
          ? Math.max(
              ...existingIds
            )
          : 1000;

      const orderId =
        highestId + 1;

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

        totalPence:
          subtotalPence,

        paymentStatus:
          "awaiting_payment",

        fulfilmentStatus:
          "not_shipped",

        trackingNumber:
          null,

        shippedAt:
          null,

        createdAt:
          new Date()
            .toISOString()
      };

      orders.set(
        orderId,
        order
      );

      db.prepare(`
        INSERT INTO orders
        (id, json)

        VALUES (?, ?)

        ON CONFLICT(id)
        DO UPDATE SET
          json = excluded.json
      `).run(
        orderId,
        JSON.stringify(
          order
        )
      );

      await safeSendMessage(
        adminTelegramId,

        `🧾 New Order

Order: #${orderId}
Customer: ${order.customerName}
Total: ${money(
          order.totalPence
        )}`
      );

      return res.json({
        ok: true,

        orderId,

        totalPence:
          order.totalPence,

        status:
          order.paymentStatus
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
      return next(
        err
      );
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
      `WEBAPP_URL: ${
        webAppUrl
          ? "configured"
          : "missing"
      }`
    );
  }
);