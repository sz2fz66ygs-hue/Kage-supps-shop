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

const port = Number(
  process.env.PORT || 3000
);

/* =========================================================
   ENVIRONMENT VARIABLES
   ========================================================= */

// Accepts either variable name in Render.
const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN;

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
   EXPRESS
   ========================================================= */

app.use(
  express.json()
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

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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

  console.log(
    `Products loaded: ${products.length}`
  );
} catch (err) {
  console.error(
    "Could not load products.json:",
    err?.message || err
  );
}

/* =========================================================
   LOAD EXISTING ORDERS
   ========================================================= */

const orders =
  new Map();

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
  } catch (err) {
    console.error(
      "Invalid stored order:",
      row.id,
      err
    );
  }
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
    ) / 100
  ).toFixed(2)}`;
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
   TELEGRAM BOT
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

    console.log(
      "Telegram bot started."
    );

    /* -------------------------
       POLLING ERRORS
       ------------------------- */

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
   SAFE SEND MESSAGE
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
   HEALTH CHECK
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

      supportConfigured:
        supportTelegramIds.length >
        0
    });
  }
);

/* =========================================================
   TELEGRAM COMMANDS
   ========================================================= */

const pendingSupport =
  new Set();

if (bot) {

  /* =======================================================
     /START
     ======================================================= */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,
    async msg => {

      const buttons = [];

      /*
        Only show Open Shop if
        WEBAPP_URL exists.
      */

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
     CALLBACK BUTTONS
     ======================================================= */

  bot.on(
    "callback_query",

    async q => {

      const chatId =
        q.message?.chat?.id;

      if (!chatId) {
        return;
      }

      /*
        Stop Telegram's loading spinner.
      */

      try {
        await bot
          .answerCallbackQuery(
            q.id
          );
      } catch {}

      /* -------------------------
         MY ORDERS
         ------------------------- */

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
                order.createdAt
                  ? new Date(
                      order.createdAt
                    )
                      .toLocaleDateString(
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

${lines.join(
  "\n\n"
)}`
        );
      }

      /* -------------------------
         SUPPORT
         ------------------------- */

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

      /* -------------------------
         INFO
         ------------------------- */

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

  /* =======================================================
     SUPPORT MESSAGE FORWARDING
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

      const supportMessage =
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
          supportMessage
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
   READ EXISTING ORDER STATUS
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
   CHECKOUT
   ========================================================= */

/*
  The current catalogue includes regulated
  and prescription products.

  This build therefore keeps catalogue
  display, Telegram, support and existing
  order-status functionality separate from
  checkout/payment processing.
*/

app.post(
  "/api/orders",

  (_req, res) => {
    res
      .status(403)
      .json({
        error:
          "Checkout is disabled on this build."
      });
  }
);

app.post(
  "/api/orders/:id/confirm-payment",

  (_req, res) => {
    res
      .status(403)
      .json({
        error:
          "Payment confirmation is disabled on this build."
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

    console.log(
      `Support IDs: ${
        supportTelegramIds.length
      }`
    );
  }
);