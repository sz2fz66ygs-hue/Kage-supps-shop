import "dotenv/config";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
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

// The code is just the customer's Telegram name/username, sanitized and
// uppercased — simple to read out loud and to remember, and already unique
// per person since Telegram usernames are unique.
function generateReferralCode(owner) {
  const slug = String(owner || "friend").replace(/[^a-zA-Z0-9_]/g, "").toUpperCase();
  return slug || "FRIEND";
}

// Returns the existing code for this owner if one exists, otherwise creates it.
function getOrCreateReferralCode(owner) {
  const code = generateReferralCode(owner);

  if (!discountCodes.has(code)) {
    discountCodes.set(code, {
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

// Crypto payment auto-confirmation (Ethereum mainnet: ETH and USDT ERC-20).
const ETH_RECEIVING_ADDRESS = (process.env.ETH_RECEIVING_ADDRESS || "").toLowerCase();
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const USDT_CONTRACT_ADDRESS = (process.env.USDT_CONTRACT_ADDRESS || "0xdAC17F958D2ee523a2206206994597C13D831ec7").toLowerCase();
const PAYMENT_TOLERANCE_PENCE = Number(process.env.PAYMENT_TOLERANCE_PENCE || 10);
const MIN_CONFIRMATIONS = Number(process.env.MIN_CONFIRMATIONS || 2);
const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function etherscanCall(params) {
  if (!ETHERSCAN_API_KEY) {
    throw Object.assign(new Error("Crypto payments are not configured"), { code: "not_configured" });
  }

  const url = new URL(ETHERSCAN_API_URL);
  url.searchParams.set("chainid", "1");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("apikey", ETHERSCAN_API_KEY);

  const res = await fetch(url);
  const data = await res.json();

  if (data.status === "0" && typeof data.result === "string" && !data.result.startsWith("0x")) {
    throw Object.assign(new Error(`Etherscan error: ${data.result}`), { code: "provider_error" });
  }

  return data;
}

async function getGbpRates() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum,tether&vs_currencies=gbp");
  const data = await res.json();
  return { ethGbp: data.ethereum.gbp, usdtGbp: data.tether.gbp };
}

async function getEthTransaction(txHash) {
  const [txRes, receiptRes, blockRes] = await Promise.all([
    etherscanCall({ module: "proxy", action: "eth_getTransactionByHash", txhash: txHash }),
    etherscanCall({ module: "proxy", action: "eth_getTransactionReceipt", txhash: txHash }),
    etherscanCall({ module: "proxy", action: "eth_blockNumber" })
  ]);

  return { tx: txRes.result, receipt: receiptRes.result, currentBlock: blockRes.result };
}

function confirmationsFor(tx, currentBlock) {
  return Number(BigInt(currentBlock) - BigInt(tx.blockNumber));
}

async function verifyEthPayment(txHash) {
  if (!ETH_RECEIVING_ADDRESS) {
    throw Object.assign(new Error("Crypto payments are not configured"), { code: "not_configured" });
  }

  const { tx, receipt, currentBlock } = await getEthTransaction(txHash);

  if (!tx) throw Object.assign(new Error("Transaction not found"), { code: "not_found" });
  if (!receipt || receipt.status !== "0x1") {
    throw Object.assign(new Error("Transaction failed or is not yet mined"), { code: "not_confirmed" });
  }
  if ((tx.to || "").toLowerCase() !== ETH_RECEIVING_ADDRESS) {
    throw Object.assign(new Error("Transaction was not sent to our receiving address"), { code: "wrong_recipient" });
  }

  const confirmations = confirmationsFor(tx, currentBlock);
  if (confirmations < MIN_CONFIRMATIONS) {
    throw Object.assign(
      new Error(`Only ${confirmations} confirmation(s) so far, need ${MIN_CONFIRMATIONS}`),
      { code: "insufficient_confirmations" }
    );
  }

  const ethPaid = Number(BigInt(tx.value)) / 1e18;
  const { ethGbp } = await getGbpRates();
  const gbpPencePaid = Math.round(ethPaid * ethGbp * 100);

  return { gbpPencePaid, confirmations, amountDisplay: `${ethPaid.toFixed(6)} ETH` };
}

async function verifyUsdtPayment(txHash) {
  if (!ETH_RECEIVING_ADDRESS) {
    throw Object.assign(new Error("Crypto payments are not configured"), { code: "not_configured" });
  }

  const { tx, receipt, currentBlock } = await getEthTransaction(txHash);

  if (!tx) throw Object.assign(new Error("Transaction not found"), { code: "not_found" });
  if (!receipt || receipt.status !== "0x1") {
    throw Object.assign(new Error("Transaction failed or is not yet mined"), { code: "not_confirmed" });
  }

  const confirmations = confirmationsFor(tx, currentBlock);
  if (confirmations < MIN_CONFIRMATIONS) {
    throw Object.assign(
      new Error(`Only ${confirmations} confirmation(s) so far, need ${MIN_CONFIRMATIONS}`),
      { code: "insufficient_confirmations" }
    );
  }

  const transferLog = (receipt.logs || []).find(log =>
    (log.address || "").toLowerCase() === USDT_CONTRACT_ADDRESS &&
    (log.topics?.[0] || "").toLowerCase() === ERC20_TRANSFER_TOPIC &&
    log.topics?.[2] &&
    ("0x" + log.topics[2].slice(-40)).toLowerCase() === ETH_RECEIVING_ADDRESS
  );

  if (!transferLog) {
    throw Object.assign(
      new Error("No USDT transfer to our receiving address was found in this transaction"),
      { code: "wrong_recipient" }
    );
  }

  const usdtPaid = Number(BigInt(transferLog.data)) / 1e6;
  const { usdtGbp } = await getGbpRates();
  const gbpPencePaid = Math.round(usdtPaid * usdtGbp * 100);

  return { gbpPencePaid, confirmations, amountDisplay: `${usdtPaid.toFixed(2)} USDT` };
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
  const { customerName, telegramUsername, address, items, discountCode, storeCreditCode } = req.body || {};

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
        balancePence: 0,
        orderCount: 0
      };
      earnings.commissionPence += commissionPence;
      earnings.balancePence += commissionPence;
      earnings.orderCount += 1;
      referralEarnings.set(normalizedCode, earnings);
    }
  }

  let storeCreditPence = 0;
  let appliedStoreCreditCode = null;

  if (storeCreditCode) {
    const normalizedCreditCode = String(storeCreditCode).trim().toUpperCase();
    const creditEarnings = referralEarnings.get(normalizedCreditCode);

    if (!creditEarnings || creditEarnings.balancePence <= 0) {
      return res.status(400).json({ error: "Invalid or empty store credit code" });
    }

    const remainingAfterDiscount = subtotalPence - discountPence;
    storeCreditPence = Math.min(creditEarnings.balancePence, remainingAfterDiscount);
    creditEarnings.balancePence -= storeCreditPence;
    referralEarnings.set(normalizedCreditCode, creditEarnings);
    appliedStoreCreditCode = normalizedCreditCode;
  }

  const totalPence = Math.max(0, subtotalPence - discountPence - storeCreditPence);

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
    storeCreditCode: appliedStoreCreditCode,
    storeCreditPence,
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
    const storeCreditLine = storeCreditPence > 0
      ? `\nStore credit: ${appliedStoreCreditCode} (-£${(storeCreditPence / 100).toFixed(2)})`
      : "";

    await bot.sendMessage(
      adminTelegramId,
      `🧾 New Order Created

Order: #${orderId}
Customer: ${customerName}
Telegram: ${telegramUsername || "Not supplied"}
Total: £${(totalPence / 100).toFixed(2)}${discountLine}${storeCreditLine}${referralLine}
Status: Awaiting payment`
    );
  }

  let payment = {
    method: "crypto_demo",
    instructions: "Crypto payments aren't configured yet — set ETH_RECEIVING_ADDRESS and ETHERSCAN_API_KEY."
  };

  if (ETH_RECEIVING_ADDRESS) {
    try {
      const { ethGbp, usdtGbp } = await getGbpRates();
      const totalGbp = totalPence / 100;

      payment = {
        method: "crypto",
        address: ETH_RECEIVING_ADDRESS,
        accepted: ["ETH", "USDT (ERC-20, Ethereum mainnet)"],
        quote: {
          ETH: (totalGbp / ethGbp).toFixed(6),
          USDT: (totalGbp / usdtGbp).toFixed(2)
        },
        instructions: "Send the exact amount shown to the address above on Ethereum mainnet, then submit your transaction hash to confirm. The quote is approximate — confirmation checks the live rate at payment time."
      };
    } catch (err) {
      console.error("Failed to fetch crypto rates", err);
    }
  }

  res.json({
    ok: true,
    orderId,
    subtotalPence,
    discountPence,
    storeCreditPence,
    totalPence,
    status: "awaiting_payment",
    payment
  });
});

// Verify an on-chain ETH or USDT (ERC-20) payment against an order and, if it
// matches within PAYMENT_TOLERANCE_PENCE, mark the order paid and forward the
// shipping details to the admin chat for fulfillment.
app.post("/api/orders/:id/confirm-payment", async (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.paymentStatus === "paid") return res.json({ ok: true, alreadyPaid: true });

  const { transactionId, asset } = req.body || {};
  if (!transactionId || !["ETH", "USDT"].includes(asset)) {
    return res.status(400).json({ error: "Provide transactionId and asset (ETH or USDT)" });
  }

  let result;
  try {
    result = asset === "ETH" ? await verifyEthPayment(transactionId) : await verifyUsdtPayment(transactionId);
  } catch (err) {
    const statusCode = err.code === "not_configured" ? 501 : err.code === "provider_error" ? 502 : 400;
    return res.status(statusCode).json({ error: err.message });
  }

  const diffPence = Math.abs(result.gbpPencePaid - order.totalPence);
  if (diffPence > PAYMENT_TOLERANCE_PENCE) {
    return res.status(400).json({
      error: `Amount mismatch: received ${result.amountDisplay} (~£${(result.gbpPencePaid / 100).toFixed(2)}), expected £${(order.totalPence / 100).toFixed(2)}`
    });
  }

  order.paymentStatus = "paid";
  order.transactionId = transactionId;
  order.paymentAsset = asset;
  order.paidAt = new Date().toISOString();
  orders.set(order.orderId, order);

  if (bot && adminTelegramId) {
    const itemLines = order.items.map(i => `${i.quantity} × ${i.name}`).join("\n");

    await bot.sendMessage(
      adminTelegramId,
      `💰 PAYMENT CONFIRMED (auto)

Order: #${order.orderId}
Customer: ${order.customerName}
Telegram: ${order.telegramUsername || "Not supplied"}
Total: £${(order.totalPence / 100).toFixed(2)} (${result.amountDisplay}, ${result.confirmations} confirmations)

Shipping address:
${order.address}

Items:
${itemLines}

Status: Paid ✅ — ready to ship`
    );
  }

  res.json({ ok: true, paymentStatus: "paid" });
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

  const code = getOrCreateReferralCode(owner);

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
    balancePence: 0,
    orderCount: 0
  };

  res.json({
    code: normalizedCode,
    owner: codeRecord.referralOwner,
    commissionPence: earnings.commissionPence,
    balancePence: earnings.balancePence,
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
      `💰 PAYMENT CONFIRMED

Order: #${order.orderId}
Customer: ${order.customerName}
Total: £${(order.totalPence / 100).toFixed(2)}
Status: Paid ✅`
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
    storeCreditPence: order.storeCreditPence,
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
      `⚡️ Welcome to Kage Supps

Everything is in one place.

🛍 Open Shop — browse the storefront
📦 My Orders — view your order history
💬 Support — get help
ℹ️ Info — important information

Choose an option below 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛍 Open Shop", web_app: { url: webAppUrl } }],
            [
              { text: "📦 My Orders", callback_data: "orders" },
              { text: "💬 Support", callback_data: "support" }
            ],
            [{ text: "ℹ️ Info", callback_data: "info" },
              { text: "🎁 Refer & Earn", callback_data: "refer" }
            ]
          ]
        }
      }
    );
  });

  bot.onText(/\/refer/, async (msg) => {
    const owner = msg.from?.username || `id${msg.from?.id}`;
    const code = getOrCreateReferralCode(owner);

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
      await bot.sendMessage(chatId, "📦 My Orders\n\nOrder history can be connected to a persistent database next.");
    }

    if (q.data === "support") {
      await bot.sendMessage(chatId, "💬 Support\n\nSend your support message here.");
    }

    if (q.data === "info") {
      await bot.sendMessage(chatId, "ℹ️ Kage Supps\n\nTap 🛍 Open Shop to launch the Mini App.");
    }

    if (q.data === "refer") {
      const owner = q.from?.username || `id${q.from?.id}`;
      const code = getOrCreateReferralCode(owner);

      await bot.sendMessage(
        chatId,
        `Your referral code: ${code}\n\nShare it — anyone who uses it gets ${REFERRAL_DISCOUNT_PERCENT}% off their order, and you earn ${REFERRAL_COMMISSION_PERCENT}% commission on every order that uses it.`
      );
    }
  });
}