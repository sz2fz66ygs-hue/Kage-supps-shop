// Full server.js replacement with tracking support
// NOTE: Keep your existing server code above this point.
import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const DATA_DIR = process.env.DATA_DIR || ".";
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "kage.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS discount_codes (code TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS referral_earnings (code TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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

const upsertOrderStmt = db.prepare(
  "INSERT INTO orders (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json"
);
const upsertDiscountCodeStmt = db.prepare(
  "INSERT INTO discount_codes (code, json) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json"
);
const upsertReferralEarningsStmt = db.prepare(
  "INSERT INTO referral_earnings (code, json) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET json = excluded.json"
);
const upsertMetaStmt = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
);
const insertCartEventStmt = db.prepare(
  "INSERT INTO cart_events (productId, action, createdAt) VALUES (?, ?, ?)"
);
const cartEventCountsStmt = db.prepare(
  "SELECT productId, action, COUNT(*) as cnt FROM cart_events WHERE createdAt >= ? GROUP BY productId, action"
);
const insertCodeUsageStmt = db.prepare(
  "INSERT OR IGNORE INTO code_usage (code, buyerKey) VALUES (?, ?)"
);
const hasCodeUsageStmt = db.prepare(
  "SELECT 1 FROM code_usage WHERE code = ? AND buyerKey = ?"
);
const upsertBuyerStatsStmt = db.prepare(`
  INSERT INTO buyer_stats (buyerKey, paidOrderCount, telegramId, telegramUsername, ownReferralCode)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(buyerKey) DO UPDATE SET
    paidOrderCount = excluded.paidOrderCount,
    telegramId = excluded.telegramId,
    telegramUsername = excluded.telegramUsername,
    ownReferralCode = excluded.ownReferralCode
`);
const getBuyerStatsStmt = db.prepare("SELECT * FROM buyer_stats WHERE buyerKey = ?");

const orders = new Map();
let nextOrderId = 1001;

const products = JSON.parse(
  readFileSync(path.join(__dirname, "public/products.json"), "utf8")
);
const productsById = new Map(products.map(p => [p.id, p]));
const discountCodes = new Map();
const referralEarnings = new Map();

function saveOrder(order) {
  orders.set(order.orderId, order);
  upsertOrderStmt.run(order.orderId, JSON.stringify(order));
}
function saveDiscountCode(code, record) {
  discountCodes.set(code, record);
  upsertDiscountCodeStmt.run(code, JSON.stringify(record));
}
function saveReferralEarnings(code, earnings) {
  referralEarnings.set(code, earnings);
  upsertReferralEarningsStmt.run(code, JSON.stringify(earnings));
}
function saveNextOrderId(id) {
  nextOrderId = id;
  upsertMetaStmt.run("nextOrderId", String(id));
}
function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setMeta(key, value) {
  upsertMetaStmt.run(key, String(value));
}
function recordCartEvent(productId, action) {
  insertCartEventStmt.run(productId, action, new Date().toISOString());
}
function buyerKeyFor({ telegramId, telegramUsername }) {
  if (telegramId) return `id:${telegramId}`;
  const username = String(telegramUsername || "").replace(/^@/, "").toLowerCase();
  return username ? `user:${username}` : null;
}
function orderBelongsToViewer(order, viewer) {
  if (viewer.telegramId && order.telegramId && String(order.telegramId) === String(viewer.telegramId)) return true;
  const orderUsername = String(order.telegramUsername || "").replace(/^@/, "").toLowerCase();
  const viewerUsername = String(viewer.telegramUsername || "").replace(/^@/, "").toLowerCase();
  return Boolean(orderUsername) && orderUsername === viewerUsername;
}
function hasCodeUsage(code, buyerKey) {
  return Boolean(hasCodeUsageStmt.get(code, buyerKey));
}
function recordCodeUsage(code, buyerKey) {
  insertCodeUsageStmt.run(code, buyerKey);
}
function getBuyerStats(buyerKey) {
  return getBuyerStatsStmt.get(buyerKey) || {
    buyerKey,
    paidOrderCount: 0,
    telegramId: null,
    telegramUsername: null,
    ownReferralCode: null
  };
}
function saveBuyerStats(stats) {
  upsertBuyerStatsStmt.run(
    stats.buyerKey,
    stats.paidOrderCount,
    stats.telegramId != null ? String(stats.telegramId) : null,
    stats.telegramUsername ?? null,
    stats.ownReferralCode ?? null
  );
}

for (const row of db.prepare("SELECT id, json FROM orders").all()) {
  orders.set(row.id, JSON.parse(row.json));
}
for (const row of db.prepare("SELECT code, json FROM discount_codes").all()) {
  discountCodes.set(row.code, JSON.parse(row.json));
}
for (const row of db.prepare("SELECT code, json FROM referral_earnings").all()) {
  referralEarnings.set(row.code, JSON.parse(row.json));
}
const nextOrderIdRow = db.prepare("SELECT value FROM meta WHERE key = ?").get("nextOrderId");
if (nextOrderIdRow) nextOrderId = Number(nextOrderIdRow.value);

const REFERRAL_DISCOUNT_PERCENT = Number(process.env.REFERRAL_DISCOUNT_PERCENT || 10);
const REFERRAL_COMMISSION_PERCENT = Number(process.env.REFERRAL_COMMISSION_PERCENT || 5);
const adminApiSecret = process.env.ADMIN_API_SECRET || "";
const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || "";
const supportTelegramIds = (process.env.SUPPORT_TELEGRAM_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const pendingSupport = new Set();

let bot = null;
if (token) bot = new TelegramBot(token, { polling: true });

function generateReferralCode(owner) {
  const slug = String(owner || "friend").replace(/[^a-zA-Z0-9_]/g, "").toUpperCase();
  return slug || "FRIEND";
}
function getOrCreateReferralCode(owner) {
  const code = generateReferralCode(owner);
  if (!discountCodes.has(code)) {
    saveDiscountCode(code, {
      discountType: "percent",
      discountValue: REFERRAL_DISCOUNT_PERCENT,
      referralOwner: owner,
      commissionPercent: REFERRAL_COMMISSION_PERCENT,
      uses: 0,
      active: true
    });
  }
  return code;
}

const LOYALTY_ORDER_THRESHOLD = 10;
async function handleLoyaltyOnPaid(order) {
  const buyerKey = buyerKeyFor(order);
  if (!buyerKey) return;
  const stats = getBuyerStats(buyerKey);
  stats.paidOrderCount += 1;
  if (order.telegramId) stats.telegramId = order.telegramId;
  if (order.telegramUsername) stats.telegramUsername = order.telegramUsername;

  let justUnlocked = false;
  if (stats.paidOrderCount >= LOYALTY_ORDER_THRESHOLD && !stats.ownReferralCode) {
    stats.ownReferralCode = getOrCreateReferralCode(stats.telegramUsername || `id${stats.telegramId}`);
    justUnlocked = true;
  }
  saveBuyerStats(stats);

  if (justUnlocked && bot && stats.telegramId) {
    await bot.sendMessage(
      stats.telegramId,
      `🎉 You've placed ${stats.paidOrderCount} orders with us! Your referral code is: ${stats.ownReferralCode}`
    ).catch(err => console.error("Failed to send loyalty unlock message", err));
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/orders", async (req, res) => {
  const { customerName, telegramUsername, telegramId, address, items } = req.body || {};
  if (!customerName || !address || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Missing order details" });
  }

  const lineItems = [];
  let subtotalPence = 0;
  for (const rawItem of items) {
    const id = Number(rawItem?.id);
    const quantity = Number(rawItem?.quantity);
    const product = productsById.get(id);
    if (!product || !Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Invalid item in basket" });
    }
    if (Number.isInteger(product.stock) && quantity > product.stock) {
      return res.status(400).json({ error: `Not enough stock for ${product.name}` });
    }
    const lineTotalPence = product.pricePence * quantity;
    subtotalPence += lineTotalPence;
    lineItems.push({ id: product.id, name: product.name, quantity, pricePence: product.pricePence, lineTotalPence });
  }

  if (subtotalPence <= 0) return res.status(400).json({ error: "Invalid total" });

  const orderId = nextOrderId;
  saveNextOrderId(nextOrderId + 1);

  const order = {
    orderId,
    customerName,
    telegramUsername: telegramUsername || "",
    telegramId: telegramId || null,
    address,
    items: lineItems,
    subtotalPence,
    totalPence: subtotalPence,
    paymentStatus: "awaiting_payment",
    fulfilmentStatus: "not_shipped",
    trackingNumber: null,
    shippedAt: null,
    createdAt: new Date().toISOString()
  };

  saveOrder(order);

  if (bot && adminTelegramId) {
    await bot.sendMessage(
      adminTelegramId,
      `🧾 New Order Created\n\nOrder: #${orderId}\nCustomer: ${customerName}\nTelegram: ${telegramUsername || "Not supplied"}\nTotal: £${(subtotalPence / 100).toFixed(2)}\nStatus: Awaiting payment`
    );
  }

  res.json({ ok: true, orderId, totalPence: subtotalPence, status: "awaiting_payment" });
});

// Generic payment webhook. Your payment provider should authenticate calls to this endpoint.
app.post("/api/payment-webhook", async (req, res) => {
  const suppliedSecret = req.header("x-webhook-secret");
  if (!paymentWebhookSecret || suppliedSecret !== paymentWebhookSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { orderId, status, transactionId } = req.body || {};
  const order = orders.get(Number(orderId));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (status !== "confirmed") return res.json({ ok: true, ignored: true });
  if (order.paymentStatus === "paid") return res.json({ ok: true, alreadyPaid: true });

  order.paymentStatus = "paid";
  order.transactionId = transactionId || "";
  order.paidAt = new Date().toISOString();
  saveOrder(order);
  await handleLoyaltyOnPaid(order);

  if (bot && adminTelegramId) {
    const itemLines = order.items.map(i => `${i.quantity} × ${i.name}`).join("\n");
    await bot.sendMessage(
      adminTelegramId,
      `💰 PAYMENT CONFIRMED\n\nOrder: #${order.orderId}\nCustomer: ${order.customerName}\nTotal: £${(order.totalPence / 100).toFixed(2)}\n\nShipping address:\n${order.address}\n\nItems:\n${itemLines}\n\nStatus: Paid ✅ — ready to ship\n\nWhen dispatched, send:\n/tracking ${order.orderId} TRACKING_NUMBER`
    );
  }

  res.json({ ok: true });
});

app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json({
    orderId: order.orderId,
    paymentStatus: order.paymentStatus,
    fulfilmentStatus: order.fulfilmentStatus || "not_shipped",
    trackingNumber: order.trackingNumber || null,
    shippedAt: order.shippedAt || null,
    totalPence: order.totalPence
  });
});

app.post("/api/cart-events", (req, res) => {
  const { productId, action } = req.body || {};
  const id = Number(productId);
  if (!productsById.has(id) || !["add", "remove"].includes(action)) {
    return res.status(400).json({ error: "Invalid cart event" });
  }
  recordCartEvent(id, action);
  res.json({ ok: true });
});

function formatMoney(pence) {
  return `£${(pence / 100).toFixed(2)}`;
}

function buildActivitySummary(sinceIso) {
  const allOrders = [...orders.values()].filter(o => o.createdAt >= sinceIso);
  const paidOrders = allOrders.filter(o => o.paymentStatus === "paid");
  const totalRevenuePaid = paidOrders.reduce((sum, o) => sum + o.totalPence, 0);
  return `Orders: ${allOrders.length} placed, ${paidOrders.length} paid (${formatMoney(totalRevenuePaid)})`;
}

const WEEKLY_SUMMARY_MS = 7 * 24 * 60 * 60 * 1000;
async function maybeSendWeeklySummary() {
  if (!bot || !adminTelegramId) return;
  const last = getMeta("lastWeeklySummaryAt");
  if (!last) {
    setMeta("lastWeeklySummaryAt", new Date().toISOString());
    return;
  }
  if (Date.now() - new Date(last).getTime() < WEEKLY_SUMMARY_MS) return;
  const summary = buildActivitySummary(last);
  await bot.sendMessage(adminTelegramId, `📊 Weekly summary\n\n${summary}`);
  setMeta("lastWeeklySummaryAt", new Date().toISOString());
}

if (bot) {
  setInterval(() => {
    maybeSendWeeklySummary().catch(err => console.error("Weekly summary failed", err));
  }, 60 * 60 * 1000);

  maybeSendWeeklySummary().catch(err => console.error("Weekly summary failed", err));

  bot.onText(/\/myid/, async msg => {
    await bot.sendMessage(msg.chat.id, `Your Telegram ID: ${msg.from.id}`);
  });

  bot.onText(/\/summary/, async msg => {
    if (!adminTelegramId || String(msg.from?.id) !== String(adminTelegramId)) {
      return bot.sendMessage(msg.chat.id, "This command is admin-only.");
    }
    const sinceIso = new Date(Date.now() - WEEKLY_SUMMARY_MS).toISOString();
    await bot.sendMessage(msg.chat.id, `📊 Last 7 days\n\n${buildActivitySummary(sinceIso)}`);
  });

  // ADMIN TRACKING COMMAND
  // Example: /tracking 1042 GB123456789GB
  bot.onText(/^\/tracking\s+(\d+)\s+(.+)$/i, async (msg, match) => {
    if (!adminTelegramId || String(msg.from?.id) !== String(adminTelegramId)) {
      return bot.sendMessage(msg.chat.id, "This command is admin-only.");
    }

    const orderId = Number(match[1]);
    const trackingNumber = match[2].trim();
    const order = orders.get(orderId);

    if (!order) return bot.sendMessage(msg.chat.id, `❌ Order #${orderId} not found.`);
    if (order.paymentStatus !== "paid") {
      return bot.sendMessage(msg.chat.id, `❌ Order #${orderId} has not been marked paid yet.`);
    }
    if (!order.telegramId) {
      return bot.sendMessage(msg.chat.id, `❌ No Telegram ID is stored for order #${orderId}.`);
    }

    order.trackingNumber = trackingNumber;
    order.fulfilmentStatus = "shipped";
    order.shippedAt = new Date().toISOString();
    saveOrder(order);

    try {
      await bot.sendMessage(
        order.telegramId,
        `📦 Your order has been dispatched\n\nOrder: #${order.orderId}\n\nTracking:\n${trackingNumber}\n\nYou can use the tracking number with the relevant courier to follow your parcel.`
      );
      await bot.sendMessage(msg.chat.id, `✅ Tracking sent\n\nOrder: #${orderId}\nTracking: ${trackingNumber}`);
    } catch (err) {
      console.error("Failed to send tracking message", err);
      await bot.sendMessage(msg.chat.id, `⚠️ Tracking was saved for order #${orderId}, but the Telegram message couldn't be delivered.`);
    }
  });
}

if (bot && webAppUrl) {
  bot.onText(/\/start/, async msg => {
    await bot.sendMessage(
      msg.chat.id,
      `⚡️ Welcome\n\n🛍 Open Shop\n📦 My Orders\n💬 Support\nℹ️ Info`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛍 Open Shop", web_app: { url: webAppUrl } }],
            [
              { text: "📦 My Orders", callback_data: "orders" },
              { text: "💬 Support", callback_data: "support" }
            ],
            [{ text: "ℹ️ Info", callback_data: "info" }]
          ]
        }
      }
    );
  });

  bot.on("callback_query", async q => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(q.id);

    if (q.data === "orders") {
      const viewer = { telegramId: q.from?.id, telegramUsername: q.from?.username };
      const matches = [...orders.values()]
        .filter(o => orderBelongsToViewer(o, viewer))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10);

      if (!matches.length) {
        await bot.sendMessage(chatId, "📦 My Orders\n\nNo orders found yet.");
      } else {
        const lines = matches.map(o => {
          let statusLabel;
          if (o.fulfilmentStatus === "shipped") statusLabel = "Shipped 📦";
          else if (o.paymentStatus === "paid") statusLabel = "Paid ✅ — awaiting dispatch";
          else statusLabel = "Awaiting payment";

          const date = new Date(o.createdAt).toLocaleDateString();
          const trackingLine = o.trackingNumber ? `\nTracking: ${o.trackingNumber}` : "";
          return `#${o.orderId} — £${(o.totalPence / 100).toFixed(2)} — ${statusLabel} (${date})${trackingLine}`;
        });
        await bot.sendMessage(chatId, `📦 My Orders\n\n${lines.join("\n\n")}`);
      }
    }

    if (q.data === "support") {
      if (!supportTelegramIds.length) {
        await bot.sendMessage(chatId, "💬 Support\n\nSupport isn't configured yet.");
      } else {
        pendingSupport.add(chatId);
        await bot.sendMessage(chatId, "💬 Support\n\nSend your message below and our team will get it.");
      }
    }

    if (q.data === "info") {
      await bot.sendMessage(chatId, "ℹ️ Info\n\nTap Open Shop to launch the Mini App.");
    }
  });

  bot.on("message", async msg => {
    const chatId = msg.chat?.id;
    if (!chatId || !pendingSupport.has(chatId)) return;
    if (!msg.text || msg.text.startsWith("/")) return;

    pendingSupport.delete(chatId);
    const from = msg.from?.username ? `@${msg.from.username}` : `Telegram id ${msg.from?.id}`;
    const forwardText = `💬 New support message\n\nFrom: ${from}\nMessage: ${msg.text}`;

    for (const id of supportTelegramIds) {
      await bot.sendMessage(id, forwardText).catch(err => console.error("Failed to forward support message", err));
    }

    await bot.sendMessage(chatId, "Thanks — your message has been sent to our support team.");
  });
}

app.listen(port, () => {
  console.log(`Kage storefront running on port ${port}`);
});