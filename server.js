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

// Persistent storage (orders, discount/referral codes, commission balances).
// DATA_DIR must point at a Render Persistent Disk (or any durable volume) —
// otherwise this file is wiped on every redeploy just like the old in-memory
// Maps were. Locally it just creates ./data/kage.sqlite.
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

// Load everything back into memory from disk at startup.
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

async function getUsdtGbpRate() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=gbp");
  const data = await res.json();
  return data.tether.gbp;
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
  const usdtGbp = await getUsdtGbpRate();
  const gbpPencePaid = Math.round(usdtPaid * usdtGbp * 100);

  return { gbpPencePaid, confirmations, amountDisplay: `${usdtPaid.toFixed(2)} USDT` };
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;
const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
const paymentWebhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || "";

// Comma-separated numeric Telegram IDs that receive forwarded support messages.
const supportTelegramIds = (process.env.SUPPORT_TELEGRAM_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Chat IDs that just tapped "Support" and are expected to send their message next.
const pendingSupport = new Set();

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
    saveDiscountCode(normalizedCode, codeRecord);

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
      saveReferralEarnings(normalizedCode, earnings);
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
    saveReferralEarnings(normalizedCreditCode, creditEarnings);
    appliedStoreCreditCode = normalizedCreditCode;
  }

  const totalPence = Math.max(0, subtotalPence - discountPence - storeCreditPence);

  const orderId = nextOrderId;
  saveNextOrderId(nextOrderId + 1);
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

  saveOrder(order);

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
      const usdtGbp = await getUsdtGbpRate();
      const totalGbp = totalPence / 100;

      payment = {
        method: "crypto",
        address: ETH_RECEIVING_ADDRESS,
        accepted: ["USDT (ERC-20, Ethereum mainnet)"],
        quote: {
          USDT: (totalGbp / usdtGbp).toFixed(2)
        },
        instructions: "Send the exact USDT amount shown to the address above on Ethereum mainnet (ERC-20), then submit your transaction hash to confirm. The quote is approximate — confirmation checks the live rate at payment time."
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

// Verify an on-chain USDT (ERC-20) payment against an order and, if it
// matches within PAYMENT_TOLERANCE_PENCE, mark the order paid and forward the
// shipping details to the admin chat for fulfillment.
app.post("/api/orders/:id/confirm-payment", async (req, res) => {
  const order = orders.get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.paymentStatus === "paid") return res.json({ ok: true, alreadyPaid: true });

  const { transactionId } = req.body || {};
  if (!transactionId) {
    return res.status(400).json({ error: "Provide transactionId" });
  }

  let result;
  try {
    result = await verifyUsdtPayment(transactionId);
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
  order.paymentAsset = "USDT";
  order.paidAt = new Date().toISOString();
  saveOrder(order);

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

  saveDiscountCode(normalizedCode, {
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
  saveOrder(order);

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

// Basket telemetry for the weekly summary: fired by the storefront whenever
// a product is added to the basket, or fully removed from it (not on every
// quantity tweak). Best-effort — the client doesn't wait on this.
app.post("/api/cart-events", (req, res) => {
  const { productId, action } = req.body || {};
  const id = Number(productId);

  if (!productsById.has(id) || !["add", "remove"].includes(action)) {
    return res.status(400).json({ error: "Invalid cart event" });
  }

  recordCartEvent(id, action);
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Kage storefront running on port ${port}`);
});

function formatMoney(pence) {
  return `£${(pence / 100).toFixed(2)}`;
}

// Sales + basket add/remove activity since sinceIso, one line per product
// that had either an order or a basket event in the window.
function buildActivitySummary(sinceIso) {
  const allOrders = [...orders.values()].filter(o => o.createdAt >= sinceIso);
  const paidOrders = allOrders.filter(o => o.paymentStatus === "paid");

  const perProduct = new Map();

  for (const o of allOrders) {
    for (const item of o.items) {
      const entry = perProduct.get(item.id) || {
        name: item.name,
        unitsOrdered: 0,
        unitsPaid: 0,
        revenuePaidPence: 0
      };
      entry.unitsOrdered += item.quantity;
      if (o.paymentStatus === "paid") {
        entry.unitsPaid += item.quantity;
        entry.revenuePaidPence += item.lineTotalPence;
      }
      perProduct.set(item.id, entry);
    }
  }

  const eventsByProduct = new Map();
  for (const row of cartEventCountsStmt.all(sinceIso)) {
    const entry = eventsByProduct.get(row.productId) || { added: 0, removed: 0 };
    entry[row.action === "add" ? "added" : "removed"] = row.cnt;
    eventsByProduct.set(row.productId, entry);
  }

  const productIds = new Set([...perProduct.keys(), ...eventsByProduct.keys()]);

  if (!productIds.size) {
    return `No orders or basket activity since ${new Date(sinceIso).toLocaleDateString()}.`;
  }

  const lines = [...productIds].map(id => {
    const product = productsById.get(id);
    const name = product?.name || perProduct.get(id)?.name || `Product #${id}`;
    const sales = perProduct.get(id);
    const events = eventsByProduct.get(id) || { added: 0, removed: 0 };
    const salesLine = sales
      ? `${sales.unitsOrdered} ordered (${sales.unitsPaid} paid, ${formatMoney(sales.revenuePaidPence)})`
      : "0 ordered";

    return `• ${name}: ${salesLine} — added to basket ${events.added}×, removed ${events.removed}×`;
  });

  const totalRevenuePaid = paidOrders.reduce((sum, o) => sum + o.totalPence, 0);

  return [
    `Orders: ${allOrders.length} placed, ${paidOrders.length} paid (${formatMoney(totalRevenuePaid)})`,
    "",
    ...lines
  ].join("\n");
}

const WEEKLY_SUMMARY_MS = 7 * 24 * 60 * 60 * 1000;

async function maybeSendWeeklySummary() {
  if (!bot || !adminTelegramId) return;

  const last = getMeta("lastWeeklySummaryAt");

  if (!last) {
    // First boot: set a baseline so the first send happens a week from now,
    // rather than immediately dumping "since the beginning of time".
    setMeta("lastWeeklySummaryAt", new Date().toISOString());
    return;
  }

  if (Date.now() - new Date(last).getTime() < WEEKLY_SUMMARY_MS) return;

  const summary = buildActivitySummary(last);
  const now = new Date().toISOString();

  await bot.sendMessage(
    adminTelegramId,
    `📊 Weekly summary (since ${new Date(last).toLocaleDateString()})\n\n${summary}`
  );
  setMeta("lastWeeklySummaryAt", now);
}

if (bot) {
  setInterval(() => {
    maybeSendWeeklySummary().catch(err => console.error("Weekly summary failed", err));
  }, 60 * 60 * 1000);
  maybeSendWeeklySummary().catch(err => console.error("Weekly summary failed", err));

  bot.onText(/\/myid/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `Your Telegram ID: ${msg.from.id}\n\nSet this as ADMIN_TELEGRAM_ID (env var) to receive order/shipping notifications and weekly summaries.`
    );
  });

  bot.onText(/\/summary/, async (msg) => {
    if (!adminTelegramId) {
      return bot.sendMessage(msg.chat.id, "ADMIN_TELEGRAM_ID isn't configured yet — send /myid to get your ID.");
    }
    if (String(msg.from?.id) !== String(adminTelegramId)) {
      return bot.sendMessage(msg.chat.id, "This command is admin-only.");
    }

    const sinceIso = new Date(Date.now() - WEEKLY_SUMMARY_MS).toISOString();
    const summary = buildActivitySummary(sinceIso);
    await bot.sendMessage(msg.chat.id, `📊 Last 7 days\n\n${summary}`);
  });
}

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
      const username = (q.from?.username || "").toLowerCase();
      const matches = [...orders.values()]
        .filter(o => (o.telegramUsername || "").replace(/^@/, "").toLowerCase() === username)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10);

      if (!username) {
        await bot.sendMessage(chatId, "📦 My Orders\n\nSet a Telegram username in your Telegram settings, and enter it at checkout, to look up your orders here.");
      } else if (!matches.length) {
        await bot.sendMessage(chatId, "📦 My Orders\n\nNo orders found for your Telegram username. Make sure you enter it exactly (e.g. @yourname) at checkout.");
      } else {
        const lines = matches.map(o => {
          const statusLabel = o.paymentStatus === "paid" ? "Paid ✅" : "Awaiting payment";
          const date = new Date(o.createdAt).toLocaleDateString();
          return `#${o.orderId} — £${(o.totalPence / 100).toFixed(2)} — ${statusLabel} (${date})`;
        });
        await bot.sendMessage(chatId, `📦 My Orders\n\n${lines.join("\n")}`);
      }
    }

    if (q.data === "support") {
      if (!supportTelegramIds.length) {
        await bot.sendMessage(chatId, "💬 Support\n\nSupport isn't configured yet — please try again later.");
      } else {
        pendingSupport.add(chatId);
        await bot.sendMessage(chatId, "💬 Support\n\nSend your message below and our team will get it.");
      }
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

  // Forwards a customer's next message to SUPPORT_TELEGRAM_IDS once they've
  // tapped "Support" — ignored for anyone not currently in that flow, and
  // for commands, so it never swallows /start, /refer, etc.
  bot.on("message", async (msg) => {
    const chatId = msg.chat?.id;
    if (!chatId || !pendingSupport.has(chatId)) return;
    if (!msg.text || msg.text.startsWith("/")) return;

    pendingSupport.delete(chatId);

    const from = msg.from?.username ? `@${msg.from.username}` : `Telegram id ${msg.from?.id}`;
    const forwardText = `💬 New support message\n\nFrom: ${from}\nMessage: ${msg.text}`;

    for (const id of supportTelegramIds) {
      await bot.sendMessage(id, forwardText).catch(err => console.error("Failed to forward support message to", id, err));
    }

    await bot.sendMessage(chatId, "Thanks — your message has been sent to our support team. We'll get back to you soon.");
  });
}