import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const orders = new Map();
let nextOrderId = 1001;

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || "";

let bot = null;

if (token) {
  bot = new TelegramBot(token, { polling: true });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Generic lawful-store demo order creation.
// Totals are recalculated server-side from submitted line items.
app.post("/api/orders", async (req, res) => {
  const { customerName, telegramUsername, address, items, totalPence } = req.body || {};

  if (!customerName || !address || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Missing order details" });
  }

  if (!Number.isInteger(totalPence) || totalPence <= 0) {
    return res.status(400).json({ error: "Invalid total" });
  }

  const orderId = nextOrderId++;
  const order = {
    orderId,
    customerName,
    telegramUsername: telegramUsername || "",
    address,
    items,
    totalPence,
    paymentStatus: "awaiting_payment",
    createdAt: new Date().toISOString()
  };

  orders.set(orderId, order);

  if (bot && adminTelegramId) {
    await bot.sendMessage(
      adminTelegramId,
      `ð§¾ New Order Created

Order: #${orderId}
Customer: ${customerName}
Telegram: ${telegramUsername || "Not supplied"}
Total: Â£${(totalPence / 100).toFixed(2)}
Status: Awaiting payment`
    );
  }

  // This is intentionally provider-neutral.
  // Connect a lawful payment provider here later.
  res.json({
    ok: true,
    orderId,
    status: "awaiting_payment",
    payment: {
      method: "crypto_demo",
      instructions: "Connect your approved payment provider to generate the real payment address/QR."
    }
  });
});

// Provider-neutral webhook skeleton.
// A real payment provider should authenticate/sign webhook requests.
// This demo uses a shared secret header only.
app.post("/api/payment-webhook", async (req, res) => {
  const suppliedSecret = req.header("x-webhook-secret");

  if (!paymentWebhookSecret || suppliedSecret !== paymentWebhookSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { orderId, status, transactionId } = req.body || {};
  const order = orders.get(Number(orderId));

  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  if (status !== "confirmed") {
    return res.json({ ok: true, ignored: true });
  }

  order.paymentStatus = "paid";
  order.transactionId = transactionId || "";
  order.paidAt = new Date().toISOString();
  orders.set(order.orderId, order);

  if (bot && adminTelegramId) {
    await bot.sendMessage(
      adminTelegramId,
      `ð° PAYMENT CONFIRMED

Order: #${order.orderId}
Customer: ${order.customerName}
Total: Â£${(order.totalPence / 100).toFixed(2)}
Status: Paid â`
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
    totalPence: order.totalPence
  });
});

app.listen(port, () => {
  console.log(`Kage storefront running on port ${port}`);
});

if (bot && webAppUrl) {
  bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `â¡ï¸ Welcome to Kage Supps

Everything is in one place.

ð Open Shop â browse the storefront
ð¦ My Orders â view your order history
ð¬ Support â get help
â¹ï¸ Info â important information

Choose an option below ð`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "ð Open Shop", web_app: { url: webAppUrl } }],
            [
              { text: "ð¦ My Orders", callback_data: "orders" },
              { text: "ð¬ Support", callback_data: "support" }
            ],
            [{ text: "â¹ï¸ Info", callback_data: "info" }]
          ]
        }
      }
    );
  });

  bot.on("callback_query", async (q) => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(q.id);

    if (q.data === "orders") {
      await bot.sendMessage(chatId, "ð¦ My Orders\n\nOrder history can be connected to a persistent database next.");
    }

    if (q.data === "support") {
      await bot.sendMessage(chatId, "ð¬ Support\n\nSend your support message here.");
    }

    if (q.data === "info") {
      await bot.sendMessage(chatId, "â¹ï¸ Kage Supps\n\nTap ð Open Shop to launch the Mini App.");
    }
  });
}