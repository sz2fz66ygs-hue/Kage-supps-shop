import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const orders = new Map();
let nextOrderId = 1001;

// Canonical, purchasable product list — the single source of truth for
// prices/stock. Both the storefront and this server read the same file
// so a client can never dictate its own price or total.
const products = JSON.parse(readFileSync(path.join(__dirname, "public/products.json"), "utf8"));
const productsById = new Map(products.map(p => [p.id, p]));

// Discount / referral codes, keyed by uppercased code.
// { discountType: "percent"|"fixed", discountValue, referralOwner, commissionPercent, uses, active }
const discountCodes = new Map();

// Accrued referral commissions, keyed by code.
// { owner, commissionPence, orderCount }
const referralEarnings = new Map();

const REFERRAL_DISCOUNT_PERCENT = Number(process.env.REFERRAL_DISCOUNT_PERCENT || 10);
const REFERRAL_COMMISSION_PERCENT = Number(process.env.REFERRAL_COMMISSION_PERCENT || 5);
const adminApiSecret = process.env.ADMIN_API_SECRET || "";

function generateReferralCode(owner) {
  const slug = String(owner || "friend")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 10) || "FRIEND";

  let code;
  do {
    code = `KAGE-${slug}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  } while (discountCodes.has(code));

  return code;
}

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
// Prices, stock and totals are always recalculated server-side from the
// canonical product list — a client can only choose product ids/quantities
// and, optionally, a discount code. It can never dictate its own price.
app.post("/api/orders", async (req, res) => {
  const { customerName, telegramUsername, address, items, discountCode } = req.body || {};

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

    lineItems.push({
      id: product.id,
      name: product.name,
      quantity,
      pricePence: product.pricePence,
      lineTotalPence
    });
  }

  if (subtotalPence <= 0) {
    return res.status(400).json({ error: "Invalid total" });
  }

  let discountPence = 0;
  let appliedCode = null;
  let referral = null;

  if (discountCode) {
    const normalizedCode = String(discountCode).trim().toUpperCase();
    const codeRecord = discountCodes.get(normalizedCode);

    if (!codeRecord || !codeRecord.active) {
      return res.status(400).json({ error: "Invalid discount code" });
    }

    discountPence = Math.min(
      codeRecord.discountType === "percent"
        ? Math.round(subtotalPence * (codeRecord.discountValue / 100))
        : codeRecord.discountValue,
      subtotalPence
    );

    appliedCode = normalizedCode;
    codeRecord.uses += 1;

    if (codeRecord.referralOwner) {
      const totalAfterDiscount = subtotalPence - discountPence;
      const commissionPence = Math.round(totalAfterDiscount * (codeRecord.commissionPercent / 100));

      referral = {
        owner: codeRecord.referralOwner,
        code: normalizedCode,
        commissionPence
      };

      const earnings = referralEarnings.get(normalizedCode) || {
        owner: codeRecord.referralOwner,
        commissionPence: 0,
        orderCount: 0
      };
      earnings.commissionPence += commissionPence;
      earnings.orderCount += 1;
      referralEarnings.set(normalizedCode, earnings);
    }
  }

  const totalPence = subtotalPence - discountPence;

  const orderId = nextOrderId++;
  const order = {
    orderId,
    customerName,
    telegramUsername: telegramUsername || "",
    address,
    items: lineItems,
    subtotalPence,
    discountCode: appliedCode,
    discountPence,
    totalPence,
    referral,
    paymentStatus: "awaiting_payment",
    createdAt: new Date().toISOString()
  };

  orders.set(orderId, order);

  if (bot && adminTelegramId) {
    const discountLine = discountPence > 0
      ? `\nCode: ${appliedCode} (-£${(discountPence / 100).toFixed(2)})`
      : "";
    const referralLine = referral
      ? `\nReferral: ${referral.owner} earns £${(referral.commissionPence / 100).toFixed(2)}`
      : "";

    await bot.sendMessage(
      adminTelegramId,
      `ð§¾ New Order Created

Order: #${orderId}
Customer: ${customerName}
Telegram: ${telegramUsername || "Not supplied"}
Total: Â£${(totalPence / 100).toFixed(2)}${discountLine}${referralLine}
Status: Awaiting payment`
    );
  }

  // This is intentionally provider-neutral.
  // Connect a lawful payment provider here later.
  res.json({
    ok: true,
    orderId,
    subtotalPence,
    discountPence,
    totalPence,
    status: "awaiting_payment",
    payment: {
      method: "crypto_demo",
      instructions: "Connect your approved payment provider to generate the real payment address/QR."
    }
  });
});

// Look up (validate) a discount/referral code without revealing who owns it.
app.get("/api/discount-codes/:code", (req, res) => {
  const normalizedCode = String(req.params.code).trim().toUpperCase();
  const codeRecord = discountCodes.get(normalizedCode);

  if (!codeRecord || !codeRecord.active) {
    return res.status(404).json({ valid: false, error: "Invalid discount code" });
  }

  res.json({
    valid: true,
    code: normalizedCode,
    discountType: codeRecord.discountType,
    discountValue: codeRecord.discountValue
  });
});

// Self-serve referral code creation: anyone can generate a code to share.
// Buyers who use it get REFERRAL_DISCOUNT_PERCENT off; the referrer earns
// REFERRAL_COMMISSION_PERCENT of each resulting order (tracked in-memory).
app.post("/api/referral-codes", (req, res) => {
  const { ownerName, ownerTelegramUsername } = req.body || {};
  const owner = (ownerTelegramUsername || ownerName || "").trim();

  if (!owner) {
    return res.status(400).json({ error: "Provide ownerName or ownerTelegramUsername" });
  }

  const code = generateReferralCode(owner);

  discountCodes.set(code, {
    discountType: "percent",
    discountValue: REFERRAL_DISCOUNT_PERCENT,
    referralOwner: owner,
    commissionPercent: REFERRAL_COMMISSION_PERCENT,
    uses: 0,
    active: true
  });

  res.json({
    ok: true,
    code,
    discountPercent: REFERRAL_DISCOUNT_PERCENT,
    commissionPercent: REFERRAL_COMMISSION_PERCENT
  });
});

// Admin-only: create a flat discount code with no referral attached.
// Requires ADMIN_API_SECRET to be configured and sent as x-admin-secret.
app.post("/api/discount-codes", (req, res) => {
  if (!adminApiSecret) {
    return res.status(501).json({ error: "Admin API not configured" });
  }

  if (req.header("x-admin-secret") !== adminApiSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { code, discountType, discountValue } = req.body || {};
  const normalizedCode = String(code || "").trim().toUpperCase();

  if (!normalizedCode) {
    return res.status(400).json({ error: "Missing code" });
  }

  if (!["percent", "fixed"].includes(discountType) || !Number.isInteger(discountValue) || discountValue <= 0) {
    return res.status(400).json({ error: "Invalid discountType/discountValue" });
  }

  if (discountType === "percent" && discountValue > 100) {
    return res.status(400).json({ error: "Percent discount cannot exceed 100" });
  }

  discountCodes.set(normalizedCode, {
    discountType,
    discountValue,
    referralOwner: null,
    commissionPercent: 0,
    uses: 0,
    active: true
  });

  res.json({ ok: true, code: normalizedCode });
});

// Check accrued commission for a referral code.
app.get("/api/referral-codes/:code/earnings", (req, res) => {
  const normalizedCode = String(req.params.code).trim().toUpperCase();
  const codeRecord = discountCodes.get(normalizedCode);

  if (!codeRecord || !codeRecord.referralOwner) {
    return res.status(404).json({ error: "Referral code not found" });
  }

  const earnings = referralEarnings.get(normalizedCode) || {
    owner: codeRecord.referralOwner,
    commissionPence: 0,
    orderCount: 0
  };

  res.json({
    code: normalizedCode,
    owner: codeRecord.referralOwner,
    commissionPence: earnings.commissionPence,
    orderCount: earnings.orderCount
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
    subtotalPence: order.subtotalPence,
    discountPence: order.discountPence,
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
            [{ text: "â¹ï¸ Info", callback_data: "info" },
              { text: "🎁 Refer & Earn", callback_data: "refer" }
            ]
          ]
        }
      }
    );
  });

  bot.onText(/\/refer/, async (msg) => {
    const owner = msg.from?.username || `id${msg.from?.id}`;

    let existingCode = null;
    for (const [code, record] of discountCodes.entries()) {
      if (record.referralOwner === owner) {
        existingCode = code;
        break;
      }
    }

    const code = existingCode || generateReferralCode(owner);

    if (!existingCode) {
      discountCodes.set(code, {
        discountType: "percent",
        discountValue: REFERRAL_DISCOUNT_PERCENT,
        referralOwner: owner,
        commissionPercent: REFERRAL_COMMISSION_PERCENT,
        uses: 0,
        active: true
      });
    }

    await bot.sendMessage(
      msg.chat.id,
      `Your referral code: ${code}\n\nShare it — anyone who uses it gets ${REFERRAL_DISCOUNT_PERCENT}% off their order, and you earn ${REFERRAL_COMMISSION_PERCENT}% commission on every order that uses it.`
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

    if (q.data === "refer") {
      const owner = q.from?.username || `id${q.from?.id}`;

      let existingCode = null;
      for (const [code, record] of discountCodes.entries()) {
        if (record.referralOwner === owner) {
          existingCode = code;
          break;
        }
      }

      const code = existingCode || generateReferralCode(owner);

      if (!existingCode) {
        discountCodes.set(code, {
          discountType: "percent",
          discountValue: REFERRAL_DISCOUNT_PERCENT,
          referralOwner: owner,
          commissionPercent: REFERRAL_COMMISSION_PERCENT,
          uses: 0,
          active: true
        });
      }

      await bot.sendMessage(
        chatId,
        `Your referral code: ${code}\n\nShare it — anyone who uses it gets ${REFERRAL_DISCOUNT_PERCENT}% off their order, and you earn ${REFERRAL_COMMISSION_PERCENT}% commission on every order that uses it.`
      );
    }
  });
}