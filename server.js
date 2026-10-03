import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);

/* =========================================================
   ENVIRONMENT
   ========================================================= */

const token =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const receivingAddress =
  process.env.ETH_RECEIVING_ADDRESS ||
  "";

const webAppUrl =
  process.env.WEBAPP_URL ||
  "";

const DATA_DIR =
  process.env.DATA_DIR ||
  ".";

const configuredAdminIds = (
  process.env.ADMIN_TELEGRAM_IDS ||
  process.env.ADMIN_TELEGRAM_ID ||
  ""
)
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

const ownerTelegramId = String(
  process.env.OWNER_TELEGRAM_ID ||
  configuredAdminIds[0] ||
  ""
);

/* =========================================================
   DEFAULT SHOP SETTINGS
   ========================================================= */

const DEFAULT_MINIMUM_ORDER_PENCE = 5000;
const DEFAULT_SHIPPING_PENCE = 500;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

const AFFILIATE_DISCOUNT_PERCENT = 10;
const AFFILIATE_COMMISSION_PERCENT = 5;

const PROTECTED_AFFILIATES = [
  {
    code: "Y8",
    owner: "@Y8_JKO"
  },
  {
    code: "TWARD",
    owner: "@tward1994"
  },
  {
    code: "CHODE10",
    owner: "@Hex_case"
  },
  {
    code: "DOMINATE",
    owner: "@dom_harriss"
  },
  {
    code: "STEVIEWONDER",
    owner: "@Steviewonder987"
  },
  {
    code: "KITTYSJ10",
    owner: "@Sjobje"
  },
  {
    code: "DABBLE",
    owner: "@Peachy001"
  }
];
const STOREWIDE_PROMO_DEFAULTS = {
  code: "WEEKEND10",
  discountPercent: 10,
  active: true,
  startsAt: "2026-10-03T00:00:00+01:00",
  endsAt: "2026-10-05T23:59:59+01:00"
};

app.use(
  express.json({
    limit: "1mb"
  })
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

CREATE TABLE IF NOT EXISTS inventory (
  product_id INTEGER PRIMARY KEY,
  stock INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  telegram_id TEXT,
  display_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  review_text TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  telegram_id TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  added_by TEXT
);
`);

/* =========================================================
   DATABASE STATEMENTS
   ========================================================= */

const upsertOrderStmt =
  db.prepare(`
    INSERT INTO orders (
      id,
      json
    )
    VALUES (?, ?)
    ON CONFLICT(id)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertDiscountStmt =
  db.prepare(`
    INSERT INTO discount_codes (
      code,
      json
    )
    VALUES (?, ?)
    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertReferralStmt =
  db.prepare(`
    INSERT INTO referral_earnings (
      code,
      json
    )
    VALUES (?, ?)
    ON CONFLICT(code)
    DO UPDATE SET
      json = excluded.json
  `);

const upsertMetaStmt =
  db.prepare(`
    INSERT INTO meta (
      key,
      value
    )
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

const insertInventoryStmt =
  db.prepare(`
    INSERT OR IGNORE INTO inventory (
      product_id,
      stock
    )
    VALUES (?, ?)
  `);

const getInventoryStmt =
  db.prepare(`
    SELECT stock
    FROM inventory
    WHERE product_id = ?
  `);

const setInventoryStmt =
  db.prepare(`
    UPDATE inventory
    SET stock = ?
    WHERE product_id = ?
  `);

const insertAdminStmt =
  db.prepare(`
    INSERT OR IGNORE INTO admins (
      telegram_id,
      added_at,
      added_by
    )
    VALUES (?, ?, ?)
  `);

const deleteAdminStmt =
  db.prepare(`
    DELETE FROM admins
    WHERE telegram_id = ?
  `);

/* =========================================================
   PRODUCT CATALOGUE
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

  if (!Array.isArray(products)) {
    throw new Error(
      "products.json must contain an array"
    );
  }

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

for (const product of products) {
  const id =
    Number(product.id);

  const stock =
    Number(product.stock);

  if (
    Number.isInteger(id) &&
    Number.isFinite(stock)
  ) {
    insertInventoryStmt.run(
      id,
      Math.max(
        0,
        Math.floor(stock)
      )
    );
  }
}

/* =========================================================
   IN-MEMORY DATA
   ========================================================= */

const orders =
  new Map();

const discountCodes =
  new Map();

const referralEarnings =
  new Map();

let nextOrderId =
  1001;

for (
  const row
  of db
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
  const row
  of db
    .prepare(
      "SELECT code, json FROM discount_codes"
    )
    .all()
) {
  try {
    discountCodes.set(
      String(row.code)
        .toUpperCase(),
      JSON.parse(row.json)
    );
  } catch {}
}

for (
  const row
  of db
    .prepare(
      "SELECT code, json FROM referral_earnings"
    )
    .all()
) {
  try {
    referralEarnings.set(
      String(row.code)
        .toUpperCase(),
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

for (
  const id
  of configuredAdminIds
) {
  insertAdminStmt.run(
    String(id),
    new Date()
      .toISOString(),
    "env"
  );
}

/* =========================================================
   HELPERS
   ========================================================= */

function nowIso() {
  return new Date()
    .toISOString();
}

function money(
  pence
) {
  return `£${(
    Number(
      pence ||
      0
    ) /
    100
  ).toFixed(2)}`;
}

function normaliseCode(
  value
) {
  return String(
    value ||
    ""
  )
    .trim()
    .toUpperCase();
}

function normaliseUsername(
  value
) {
  return String(
    value ||
    ""
  )
    .replace(
      /^@/,
      ""
    )
    .trim()
    .toLowerCase();
}

function saveOrder(
  order
) {
  orders.set(
    Number(
      order.orderId
    ),
    order
  );

  upsertOrderStmt.run(
    Number(
      order.orderId
    ),
    JSON.stringify(
      order
    )
  );
}

function saveDiscountCode(
  code,
  record
) {
  const clean =
    normaliseCode(
      code
    );

  discountCodes.set(
    clean,
    record
  );

  upsertDiscountStmt.run(
    clean,
    JSON.stringify(
      record
    )
  );
}

function saveReferralEarnings(
  code,
  record
) {
  const clean =
    normaliseCode(
      code
    );

  referralEarnings.set(
    clean,
    record
  );

  upsertReferralStmt.run(
    clean,
    JSON.stringify(
      record
    )
  );
}

function saveNextOrderId(
  value
) {
  nextOrderId =
    Number(value);

  upsertMetaStmt.run(
    "nextOrderId",
    String(value)
  );
}

function getMetaValue(
  key,
  fallback = null
) {
  const row =
    db
      .prepare(
        "SELECT value FROM meta WHERE key = ?"
      )
      .get(
        key
      );

  return row
    ? row.value
    : fallback;
}

function setMetaValue(
  key,
  value
) {
  upsertMetaStmt.run(
    key,
    String(value)
  );
}

function getNumberSetting(
  key,
  fallback
) {
  const value =
    Number(
      getMetaValue(
        key,
        fallback
      )
    );

  return Number.isFinite(
    value
  )
    ? value
    : fallback;
}

function getBooleanSetting(
  key,
  fallback
) {
  const value =
    getMetaValue(
      key,
      fallback
        ? "true"
        : "false"
    );

  return String(value) ===
    "true";
}

function minimumOrderPence() {
  return getNumberSetting(
    "setting:minimumOrderPence",
    DEFAULT_MINIMUM_ORDER_PENCE
  );
}

function shippingPence() {
  return getNumberSetting(
    "setting:shippingPence",
    DEFAULT_SHIPPING_PENCE
  );
}

function lowStockThreshold() {
  return getNumberSetting(
    "setting:lowStockThreshold",
    DEFAULT_LOW_STOCK_THRESHOLD
  );
}

function acceptingOrders() {
  return getBooleanSetting(
    "setting:acceptingOrders",
    true
  );
}

function getLiveStock(
  productId
) {
  const row =
    getInventoryStmt.get(
      Number(
        productId
      )
    );

  return row
    ? Number(row.stock)
    : null;
}

function getLiveProducts() {
  return products.map(
    product => {
      const liveStock =
        getLiveStock(
          product.id
        );

      return {
        ...product,
        stock:
          liveStock !== null
            ? liveStock
            : product.stock
      };
    }
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
            record.discountValue ||
            0
          ) /
          100
        )
      )
    );
  }

  return Math.min(
    subtotalPence,

    Math.max(
      0,

      Number(
        record.discountValue ||
        0
      )
    )
  );
}

function getStorewidePromo() {
  return {
    code:
      normaliseCode(
        getMetaValue(
          "storewidePromo:code",
          STOREWIDE_PROMO_DEFAULTS.code
        )
      ),

    discountPercent:
      getNumberSetting(
        "storewidePromo:discountPercent",
        STOREWIDE_PROMO_DEFAULTS.discountPercent
      ),

    active:
      getBooleanSetting(
        "storewidePromo:active",
        STOREWIDE_PROMO_DEFAULTS.active
      ),

    startsAt:
      getMetaValue(
        "storewidePromo:startsAt",
        STOREWIDE_PROMO_DEFAULTS.startsAt
      ),

    endsAt:
      getMetaValue(
        "storewidePromo:endsAt",
        STOREWIDE_PROMO_DEFAULTS.endsAt
      )
  };
}

function isStorewidePromoLive(
  promo =
    getStorewidePromo()
) {
  if (!promo.active) {
    return false;
  }

  const now =
    Date.now();

  const starts =
    promo.startsAt
      ? new Date(
          promo.startsAt
        ).getTime()
      : null;

  const ends =
    promo.endsAt
      ? new Date(
          promo.endsAt
        ).getTime()
      : null;

  if (
    Number.isFinite(starts) &&
    now < starts
  ) {
    return false;
  }

  if (
    Number.isFinite(ends) &&
    now > ends
  ) {
    return false;
  }

  return true;
}

function storewideDiscountForSubtotal(
  subtotalPence,
  promo
) {
  if (
    !promo ||
    !isStorewidePromoLive(
      promo
    )
  ) {
    return 0;
  }

  return Math.min(
    subtotalPence,

    Math.round(
      subtotalPence *
      (
        Number(
          promo.discountPercent ||
          0
        ) /
        100
      )
    )
  );
}

function addTimeline(
  order,
  status,
  by = "system",
  details = ""
) {
  if (
    !Array.isArray(
      order.timeline
    )
  ) {
    order.timeline =
      [];
  }

  order.timeline.push({
    status,

    by:
      String(by),

    details:
      String(
        details ||
        ""
      ),

    createdAt:
      nowIso()
  });
}

function logActivity(
  adminId,
  action,
  details = ""
) {
  db
    .prepare(`
      INSERT INTO activity_log (
        admin_id,
        action,
        details,
        created_at
      )
      VALUES (?, ?, ?, ?)
    `)
    .run(
      String(
        adminId ||
        ""
      ),

      String(action),

      String(
        details ||
        ""
      ),

      nowIso()
    );
}

function getSortedOrders() {
  return [
    ...orders.values()
  ]
    .sort(
      (
        a,
        b
      ) =>
        new Date(
          b.createdAt ||
          0
        ) -
        new Date(
          a.createdAt ||
          0
        )
    );
}

function getOrderStatusText(
  order
) {
  if (
    order.paymentStatus ===
    "cancelled"
  ) {
    return "Cancelled ❌";
  }

  if (
    order.fulfilmentStatus ===
    "completed"
  ) {
    return "Completed ✅";
  }

  if (
    order.fulfilmentStatus ===
    "shipped"
  ) {
    return "Dispatched 🚚";
  }

  if (
    order.fulfilmentStatus ===
    "packed"
  ) {
    return "Packed 📦";
  }

  if (
    order.fulfilmentStatus ===
    "needs_packing"
  ) {
    return "Needs packing 🧺";
  }

  if (
    order.paymentStatus ===
    "paid"
  ) {
    return "Paid ✅";
  }

  if (
    order.paymentStatus ===
    "payment_submitted"
  ) {
    return "Payment submitted ⏳";
  }

  return "Awaiting payment";
}

function isOwner(
  userId
) {
  return Boolean(
    ownerTelegramId &&
    String(userId) ===
      ownerTelegramId
  );
}

function isAdmin(
  userId
) {
  if (!userId) {
    return false;
  }

  const row =
    db
      .prepare(
        "SELECT telegram_id FROM admins WHERE telegram_id = ?"
      )
      .get(
        String(userId)
      );

  return Boolean(row) ||
    isOwner(userId);
}

function allAdminIds() {
  const ids =
    db
      .prepare(
        "SELECT telegram_id FROM admins"
      )
      .all()
      .map(
        row =>
          String(
            row.telegram_id
          )
      );

  if (
    ownerTelegramId &&
    !ids.includes(
      ownerTelegramId
    )
  ) {
    ids.push(
      ownerTelegramId
    );
  }

  return [
    ...new Set(ids)
  ];
}

function csvEscape(
  value
) {
  const text =
    String(
      value ??
      ""
    );

  return `"${text.replaceAll(
    `"`,
    `""`
  )}"`;
}

function orderMatchesCustomer(
  order,
  query
) {
  const q =
    String(
      query ||
      ""
    )
      .trim()
      .toLowerCase();

  if (!q) {
    return false;
  }

  return [
    order.customerName,
    order.telegramUsername,
    order.telegramId,
    order.address
  ].some(
    value =>
      String(
        value ||
        ""
      )
        .toLowerCase()
        .includes(
          q
        )
  );
}

function formatItems(
  order
) {
  return (
    order.items ||
    []
  )
    .map(
      item =>
        `• ${item.name} × ${item.quantity} — ${money(
          Number(
            item.lineTotalPence ??
            (
              Number(
                item.pricePence ||
                0
              ) *
              Number(
                item.quantity ||
                0
              )
            )
          )
        )}`
    )
    .join(
      "\n"
    );
}

function formatOrderAdmin(
  order
) {
  const itemsText =
    formatItems(
      order
    );

  return `📦 ORDER #${order.orderId}

Customer:
${order.customerName}

Telegram:
${order.telegramUsername || order.telegramId || "-"}

Status:
${getOrderStatusText(order)}

━━━━━━━━━━━━━━
🛒 ITEMS
━━━━━━━━━━━━━━

${itemsText || "No item details saved"}

━━━━━━━━━━━━━━

Subtotal:
${money(order.subtotalPence)}

Affiliate saving:
${money(order.affiliateDiscountPence)}

Promo saving:
${money(order.storewideDiscountPence)}

Store credit:
${money(order.storeCreditUsedPence)}

Shipping:
${money(order.shippingPence)}

TOTAL:
${money(order.totalPence)}

TX:
${order.transactionId || "Not submitted"}

Tracking:
${order.trackingNumber || "Not added"}

Address:
${order.address}`;
}

/* =========================================================
   SEED AFFILIATES
   ========================================================= */

for (
  const affiliate
  of PROTECTED_AFFILIATES
) {
  saveDiscountCode(
    affiliate.code,

    {
      code:
        affiliate.code,

      discountType:
        "percent",

      discountValue:
        AFFILIATE_DISCOUNT_PERCENT,

      referralOwner:
        affiliate.owner,

      commissionPercent:
        AFFILIATE_COMMISSION_PERCENT,

      cashOnly:
        true,

      active:
        true,

      protected:
        true
    }
  );

  const existing =
    referralEarnings.get(
      affiliate.code
    );

  if (!existing) {
    saveReferralEarnings(
      affiliate.code,

      {
        code:
          affiliate.code,

        owner:
          affiliate.owner,

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
    saveReferralEarnings(
      affiliate.code,

      {
        ...existing,

        code:
          affiliate.code,

        owner:
          affiliate.owner,

        cashOnly:
          true,

        balancePence:
          Number(
            existing.balancePence ||
            0
          ),

        totalEarnedPence:
          Number(
            existing.totalEarnedPence ||
            0
          ),

        paidOutPence:
          Number(
            existing.paidOutPence ||
            0
          )
      }
    );
  }
}

/* =========================================================
   INITIAL SHOP META
   ========================================================= */

const defaultMeta = {
  "storewidePromo:code":
    STOREWIDE_PROMO_DEFAULTS.code,

  "storewidePromo:discountPercent":
    STOREWIDE_PROMO_DEFAULTS.discountPercent,

  "storewidePromo:active":
    STOREWIDE_PROMO_DEFAULTS.active,

  "storewidePromo:startsAt":
    STOREWIDE_PROMO_DEFAULTS.startsAt,

  "storewidePromo:endsAt":
    STOREWIDE_PROMO_DEFAULTS.endsAt,

  "setting:minimumOrderPence":
    DEFAULT_MINIMUM_ORDER_PENCE,

  "setting:shippingPence":
    DEFAULT_SHIPPING_PENCE,

  "setting:lowStockThreshold":
    DEFAULT_LOW_STOCK_THRESHOLD,

  "setting:acceptingOrders":
    true
};

for (
  const [
    key,
    value
  ]
  of Object.entries(
    defaultMeta
  )
) {
  if (
    getMetaValue(
      key
    ) ===
    null
  ) {
    setMetaValue(
      key,
      value
    );
  }
}

/* =========================================================
   PRODUCT ROUTES
   ========================================================= */

app.get(
  "/products.json",

  (
    _req,
    res
  ) => {
    res.json(
      getLiveProducts()
    );
  }
);

app.get(
  "/api/products",

  (
    _req,
    res
  ) => {
    res.json(
      getLiveProducts()
    );
  }
);

app.get(
  "/health",

  (
    _req,
    res
  ) => {
    const promo =
      getStorewidePromo();

    res.json({
      ok:
        true,

      products:
        products.length,

      orders:
        orders.size,

      telegramConfigured:
        Boolean(token),

      paymentAddressConfigured:
        Boolean(
          receivingAddress
        ),

      acceptingOrders:
        acceptingOrders(),

      storewidePromo: {
        ...promo,

        live:
          isStorewidePromoLive(
            promo
          )
      }
    });
  }
);

app.post(
  "/api/cart-events",

  (
    req,
    res
  ) => {
    const productId =
      Number(
        req.body?.productId
      );

    const action =
      String(
        req.body?.action ||
        ""
      );

    if (
      !productsById.has(
        productId
      ) ||
      ![
        "add",
        "remove"
      ].includes(
        action
      )
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
      nowIso()
    );

    return res.json({
      ok:
        true
    });
  }
);

/* =========================================================
   DISCOUNT ROUTES
   ========================================================= */

app.get(
  "/api/discount-codes/:code",

  (
    req,
    res
  ) => {
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
      record.active ===
        false
    ) {
      return res
        .status(404)
        .json({
          valid:
            false,

          error:
            "That code isn't valid."
        });
    }

    return res.json({
      valid:
        true,

      code,

      discountType:
        record.discountType,

      discountValue:
        record.discountValue
    });
  }
);

app.get(
  "/api/storewide-promo/:code",

  (
    req,
    res
  ) => {
    const code =
      normaliseCode(
        req.params.code
      );

    const promo =
      getStorewidePromo();

    if (
      code !==
        promo.code ||
      !isStorewidePromoLive(
        promo
      )
    ) {
      return res
        .status(404)
        .json({
          valid:
            false,

          error:
            "That store promo isn't active."
        });
    }

    return res.json({
      valid:
        true,

      code:
        promo.code,

      discountPercent:
        promo.discountPercent,

      stacksWithAffiliate:
        true,

      startsAt:
        promo.startsAt,

      endsAt:
        promo.endsAt
    });
  }
);

app.get(
  "/api/referral-codes/:code/earnings",

  (
    req,
    res
  ) => {
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

      owner:
        record.owner ||
        null,

      balancePence:
        Number(
          record.balancePence ||
          0
        ),

      cashOnly:
        record.cashOnly ===
        true
    });
  }
);

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

    if (
      !response.ok
    ) {
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
      gbpPerUsdt <=
        0
    ) {
      return null;
    }

    return (
      (
        Number(
          totalPence
        ) /
        100
      ) /
      gbpPerUsdt
    )
      .toFixed(2);

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
   CREATE ORDER
   ========================================================= */

app.post(
  "/api/orders",

  async (
    req,
    res
  ) => {
    try {
      if (
        !acceptingOrders()
      ) {
        return res
          .status(503)
          .json({
            error:
              "The shop is temporarily not accepting orders."
          });
      }

      const customerName =
        String(
          req.body?.customerName ||
          ""
        )
          .trim();

      const telegramUsername =
        String(
          req.body?.telegramUsername ||
          ""
        )
          .trim();

      const telegramId =
        req.body?.telegramId
          ? String(
              req.body.telegramId
            )
          : null;

      const address =
        String(
          req.body?.address ||
          ""
        )
          .trim();

      const submittedItems =
        Array.isArray(
          req.body?.items
        )
          ? req.body.items
          : [];

      if (
        !customerName ||
        !address ||
        !submittedItems.length
      ) {
        return res
          .status(400)
          .json({
            error:
              "Name, delivery address and basket are required."
          });
      }

      const items =
        [];

      let subtotalPence =
        0;

      for (
        const rawItem
        of submittedItems
      ) {
        const id =
          Number(
            rawItem.id
          );

        const quantity =
          Number(
            rawItem.quantity
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
          quantity <=
            0
        ) {
          return res
            .status(400)
            .json({
              error:
                "Your basket contains an invalid item."
            });
        }

        const pricePence =
          Number(
            product.pricePence
          );

        if (
          !Number.isFinite(
            pricePence
          ) ||
          pricePence <
            0 ||
          product.purchasable ===
            false
        ) {
          return res
            .status(400)
            .json({
              error:
                `${product.name} is not currently purchasable.`
            });
        }

        const stock =
          getLiveStock(
            id
          );

        if (
          stock !==
            null &&
          quantity >
            stock
        ) {
          return res
            .status(409)
            .json({
              error:
                `Only ${stock} of ${product.name} remain in stock.`
            });
        }

        const lineTotalPence =
          pricePence *
          quantity;

        subtotalPence +=
          lineTotalPence;

        items.push({
          id,

          name:
            product.name,

          quantity,

          pricePence,

          lineTotalPence
        });
      }

      if (
        subtotalPence <
        minimumOrderPence()
      ) {
        return res
          .status(400)
          .json({
            error:
              `Minimum order is ${money(
                minimumOrderPence()
              )} before discounts.`
          });
      }

      let discountCode =
        null;

      let affiliateDiscountPence =
        0;

      let referralOwner =
        null;

      let referralCommissionPence =
        0;

      if (
        req.body?.discountCode
      ) {
        const entered =
          normaliseCode(
            req.body.discountCode
          );

        const record =
          discountCodes.get(
            entered
          );

        if (
          !record ||
          record.active ===
            false
        ) {
          return res
            .status(400)
            .json({
              error:
                "Affiliate code is not valid."
            });
        }

        discountCode =
          entered;

        affiliateDiscountPence =
          calculateDiscount(
            subtotalPence,
            record
          );

        referralOwner =
          record.referralOwner ||
          null;

        referralCommissionPence =
          Math.round(
            subtotalPence *
            (
              Number(
                record.commissionPercent ||
                0
              ) /
              100
            )
          );
      }

      let storewideCode =
        null;

      let storewideDiscountPence =
        0;

      const promo =
        getStorewidePromo();

      if (
        req.body?.storewideCode
      ) {
        const entered =
          normaliseCode(
            req.body.storewideCode
          );

        if (
          entered !==
            promo.code ||
          !isStorewidePromoLive(
            promo
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "Store-wide promo code is not currently valid."
            });
        }

        storewideCode =
          promo.code;

        storewideDiscountPence =
          storewideDiscountForSubtotal(
            subtotalPence,
            promo
          );
      }

      const totalDiscountPence =
        Math.min(
          subtotalPence,

          affiliateDiscountPence +
          storewideDiscountPence
        );

      let storeCreditCode =
        null;

      let storeCreditUsedPence =
        0;

      if (
        req.body?.storeCreditCode
      ) {
        const entered =
          normaliseCode(
            req.body.storeCreditCode
          );

        const creditRecord =
          referralEarnings.get(
            entered
          );

        if (
          !creditRecord ||
          creditRecord.cashOnly ===
            true
        ) {
          return res
            .status(400)
            .json({
              error:
                "That code cannot be used as store credit."
            });
        }

        const remainingAfterDiscounts =
          Math.max(
            0,

            subtotalPence -
            totalDiscountPence
          );

        storeCreditUsedPence =
          Math.min(
            remainingAfterDiscounts,

            Math.max(
              0,

              Number(
                creditRecord.balancePence ||
                0
              )
            )
          );

        if (
          storeCreditUsedPence >
          0
        ) {
          storeCreditCode =
            entered;

          creditRecord.balancePence =
            Number(
              creditRecord.balancePence ||
              0
            ) -
            storeCreditUsedPence;

          saveReferralEarnings(
            entered,
            creditRecord
          );
        }
      }

      const deliveryPence =
        shippingPence();

      const totalPence =
        Math.max(
          0,

          subtotalPence -
          totalDiscountPence -
          storeCreditUsedPence +
          deliveryPence
        );

      const orderId =
        nextOrderId;

      saveNextOrderId(
        orderId +
        1
      );

      const order = {
        orderId,

        customerName,

        telegramUsername,

        telegramId,

        address,

        items,

        subtotalPence,

        discountCode,

        affiliateDiscountPence,

        storewideCode,

        storewideDiscountPence,

        totalDiscountPence,

        storeCreditCode,

        storeCreditUsedPence,

        shippingPence:
          deliveryPence,

        totalPence,

        referralOwner,

        referralCommissionPence,

        referralCredited:
          false,

        stockDeducted:
          false,

        paymentStatus:
          "awaiting_payment",

        fulfilmentStatus:
          "awaiting_payment",

        transactionId:
          null,

        trackingNumber:
          null,

        reviewToken:
          randomUUID(),

        createdAt:
          nowIso(),

        timeline:
          []
      };

      addTimeline(
        order,
        "created",

        telegramId ||
        telegramUsername ||
        "customer",

        "Order created"
      );

      saveOrder(
        order
      );

      const usdtQuote =
        await getUsdtQuote(
          totalPence
        );

      const itemsText =
        formatItems(
          order
        );

      await sendToAdmins(
`🆕 NEW ORDER #${orderId}

Customer:
${customerName}

Telegram:
${telegramUsername || telegramId || "Not supplied"}

━━━━━━━━━━━━━━
🛒 ITEMS
━━━━━━━━━━━━━━

${itemsText || "No item details saved"}

━━━━━━━━━━━━━━

Subtotal:
${money(subtotalPence)}

Affiliate saving:
${money(affiliateDiscountPence)}

Store promo saving:
${money(storewideDiscountPence)}

Total saving:
${money(totalDiscountPence)}

Store credit:
${money(storeCreditUsedPence)}

Shipping:
${money(deliveryPence)}

TOTAL:
${money(totalPence)}

━━━━━━━━━━━━━━

Address:
${address}`
      );

      return res.json({
        ok:
          true,

        orderId,

        subtotalPence,

        affiliateDiscountPence,

        storewideDiscountPence,

        totalDiscountPence,

        storeCreditUsedPence,

        shippingPence:
          deliveryPence,

        totalPence,

        payment: {
          method:
            "crypto",

          address:
            receivingAddress,

          quote: {
            USDT:
              usdtQuote
          },

          instructions:
            "Send the exact amount, then submit the Ethereum transaction hash. Payment is confirmed manually after verification."
        }
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
            "Could not create order."
        });
    }
  }
);

/* =========================================================
   ORDER LOOKUP
   ========================================================= */

app.get(
  "/api/orders/:id",

  (
    req,
    res
  ) => {
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
            "Order not found."
        });
    }

    return res.json({
      orderId:
        order.orderId,

      paymentStatus:
        order.paymentStatus,

      fulfilmentStatus:
        order.fulfilmentStatus,

      totalPence:
        order.totalPence,

      trackingNumber:
        order.trackingNumber ||
        null,

      createdAt:
        order.createdAt
    });
  }
);

/* =========================================================
   SUBMIT PAYMENT HASH
   ========================================================= */

app.post(
  "/api/orders/:id/confirm-payment",

  (
    req,
    res
  ) => {
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
            "Order not found."
        });
    }

    if (
      order.paymentStatus ===
      "paid"
    ) {
      return res.json({
        ok:
          true,

        status:
          "paid"
      });
    }

    if (
      order.paymentStatus ===
      "cancelled"
    ) {
      return res
        .status(400)
        .json({
          error:
            "This order has been cancelled."
        });
    }

    const transactionId =
      String(
        req.body?.transactionId ||
        ""
      )
        .trim();

    if (
      !/^0x[a-fA-F0-9]{64}$/
        .test(
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

    for (
      const existing
      of orders.values()
    ) {
      if (
        existing.orderId !==
          order.orderId &&
        String(
          existing.transactionId ||
          ""
        )
          .toLowerCase() ===
        transactionId
          .toLowerCase()
      ) {
        return res
          .status(409)
          .json({
            error:
              "That transaction hash has already been submitted."
          });
      }
    }

    order.transactionId =
      transactionId;

    order.paymentStatus =
      "payment_submitted";

    order.paymentSubmittedAt =
      nowIso();

    addTimeline(
      order,
      "payment_submitted",

      order.telegramId ||
      "customer",

      transactionId
    );

    saveOrder(
      order
    );

    const paymentItemsText =
      formatItems(
        order
      );

    sendToAdmins(
`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

━━━━━━━━━━━━━━
🛒 ITEMS
━━━━━━━━━━━━━━

${paymentItemsText || "No item details saved"}

━━━━━━━━━━━━━━

Total:
${money(order.totalPence)}

TX:
${transactionId}

Verify independently, then use:

/paid ${order.orderId}`
    )
      .catch(
        () => {}
      );

    return res.json({
      ok:
        true,

      status:
        "payment_submitted"
    });
  }
);

/* =========================================================
   STOCK
   ========================================================= */

async function alertStockChange(
  product,
  previousStock,
  newStock
) {
  const threshold =
    lowStockThreshold();

  if (
    newStock ===
      0 &&
    previousStock !==
      0
  ) {
    await sendToAdmins(
`❌ OUT OF STOCK

${product.name}

Product ID:
${product.id}`
    );

  } else if (
    newStock >
      0 &&
    newStock <=
      threshold &&
    previousStock >
      threshold
  ) {
    await sendToAdmins(
`📉 LOW STOCK

${product.name}

Remaining:
${newStock}

Alert level:
${threshold}`
    );
  }
}

async function deductStockForOrder(
  order
) {
  if (
    order.stockDeducted
  ) {
    return {
      ok:
        true,

      alreadyDone:
        true
    };
  }

  for (
    const item
    of order.items ||
    []
  ) {
    const stock =
      getLiveStock(
        item.id
      );

    if (
      stock !==
        null &&
      stock <
        Number(
          item.quantity
        )
    ) {
      return {
        ok:
          false,

        error:
          `Not enough stock for ${item.name}. Available: ${stock}.`
      };
    }
  }

  const changes =
    [];

  db.exec(
    "BEGIN"
  );

  try {
    for (
      const item
      of order.items ||
      []
    ) {
      const oldStock =
        getLiveStock(
          item.id
        );

      if (
        oldStock ===
        null
      ) {
        continue;
      }

      const newStock =
        oldStock -
        Number(
          item.quantity
        );

      setInventoryStmt.run(
        newStock,
        Number(
          item.id
        )
      );

      changes.push({
        product:
          productsById.get(
            Number(
              item.id
            )
          ) ||
          item,

        oldStock,

        newStock
      });
    }

    db.exec(
      "COMMIT"
    );

  } catch (err) {
    db.exec(
      "ROLLBACK"
    );

    throw err;
  }

  order.stockDeducted =
    true;

  order.stockDeductedAt =
    nowIso();

  saveOrder(
    order
  );

  for (
    const change
    of changes
  ) {
    await alertStockChange(
      change.product,
      change.oldStock,
      change.newStock
    );
  }

  return {
    ok:
      true
  };
}

/* =========================================================
   AFFILIATE COMMISSION
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

  const record =
    referralEarnings.get(
      code
    ) ||
    {
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
        true
    };

  record.balancePence =
    Number(
      record.balancePence ||
      0
    ) +
    Number(
      order.referralCommissionPence ||
      0
    );

  record.totalEarnedPence =
    Number(
      record.totalEarnedPence ||
      0
    ) +
    Number(
      order.referralCommissionPence ||
      0
    );

  saveReferralEarnings(
    code,
    record
  );

  order.referralCredited =
    true;

  saveOrder(
    order
  );
}

/* =========================================================
   MARK ORDER PAID
   ========================================================= */

async function markOrderPaid(
  order,
  adminId = "system"
) {
  if (
    order.paymentStatus ===
    "paid"
  ) {
    return {
      ok:
        true,

      alreadyPaid:
        true
    };
  }

  if (
    order.paymentStatus ===
    "cancelled"
  ) {
    return {
      ok:
        false,

      error:
        "This order is cancelled."
    };
  }

  const stockResult =
    await deductStockForOrder(
      order
    );

  if (
    !stockResult.ok
  ) {
    return stockResult;
  }

  order.paymentStatus =
    "paid";

  order.fulfilmentStatus =
    "needs_packing";

  order.paidAt =
    nowIso();

  addTimeline(
    order,
    "paid",
    adminId,
    "Payment confirmed by admin"
  );

  addTimeline(
    order,
    "needs_packing",
    adminId,
    "Moved to packing queue"
  );

  saveOrder(
    order
  );

  if (
    !order.referralCredited &&
    Number(
      order.referralCommissionPence ||
      0
    ) >
      0
  ) {
    creditReferralForOrder(
      order
    );
  }

  logActivity(
    adminId,
    "mark_paid",
    `Order #${order.orderId}`
  );

  if (
    order.telegramId
  ) {
    await safeSendMessage(
      order.telegramId,

`✅ Payment confirmed

Order:
#${order.orderId}

Total:
${money(order.totalPence)}

Your order is now being prepared.`
    );
  }

  return {
    ok:
      true
  };
}

/* =========================================================
   REVIEWS API
   ========================================================= */

app.post(
  "/api/reviews",

  (
    req,
    res
  ) => {
    const orderId =
      Number(
        req.body?.orderId
      );

    const tokenValue =
      String(
        req.body?.token ||
        ""
      );

    const displayName =
      String(
        req.body?.displayName ||
        ""
      )
        .trim();

    const rating =
      Number(
        req.body?.rating
      );

    const reviewText =
      String(
        req.body?.reviewText ||
        ""
      )
        .trim();

    const order =
      orders.get(
        orderId
      );

    if (
      !order ||
      order.paymentStatus !==
        "paid"
    ) {
      return res
        .status(400)
        .json({
          error:
            "A paid order is required."
        });
    }

    if (
      !tokenValue ||
      tokenValue !==
        order.reviewToken
    ) {
      return res
        .status(403)
        .json({
          error:
            "Invalid review link."
        });
    }

    if (
      !displayName ||
      !Number.isInteger(
        rating
      ) ||
      rating <
        1 ||
      rating >
        5 ||
      !reviewText
    ) {
      return res
        .status(400)
        .json({
          error:
            "Name, rating and review are required."
        });
    }

    try {
      db
        .prepare(`
          INSERT INTO reviews (
            order_id,
            telegram_id,
            display_name,
            rating,
            review_text,
            approved,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, 0, ?)
        `)
        .run(
          orderId,
          order.telegramId ||
          null,
          displayName,
          rating,
          reviewText,
          nowIso()
        );

    } catch {
      return res
        .status(409)
        .json({
          error:
            "A review has already been submitted for this order."
        });
    }

    return res.json({
      ok:
        true
    });
  }
);

app.get(
  "/api/reviews",

  (
    _req,
    res
  ) => {
    const rows =
      db
        .prepare(`
          SELECT
            id,
            display_name,
            rating,
            review_text,
            created_at
          FROM reviews
          WHERE approved = 1
          ORDER BY id DESC
        `)
        .all();

    return res.json(
      rows
    );
  }
);

/* =========================================================
   STATIC WEBSITE
   ========================================================= */

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

/* =========================================================
   TELEGRAM BOT
   ========================================================= */

let bot =
  null;

if (token) {
  try {
    bot =
      new TelegramBot(
        token,
        {
          polling:
            true
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
          "TELEGRAM ERROR:",
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
    "Telegram bot token missing."
  );
}

/* =========================================================
   TELEGRAM HELPERS
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
    return null;
  }

  try {
    return await bot.sendMessage(
      chatId,
      message,
      options
    );

  } catch (err) {
    console.error(
      "TELEGRAM SEND ERROR:",
      err?.response?.body ||
      err?.message ||
      err
    );

    return null;
  }
}

async function sendToAdmins(
  message,
  options
) {
  if (!bot) {
    return;
  }

  for (
    const id
    of allAdminIds()
  ) {
    await safeSendMessage(
      id,
      message,
      options
    );
  }
}

/* =========================================================
   ADMIN SUMMARY
   ========================================================= */

function getAdminSummaryText() {
  const list =
    getSortedOrders();

  const awaitingPayments =
    list.filter(
      order =>
        order.paymentStatus ===
        "payment_submitted"
    ).length;

  const packing =
    list.filter(
      order =>
        order.fulfilmentStatus ===
        "needs_packing"
    ).length;

  const dispatch =
    list.filter(
      order =>
        order.fulfilmentStatus ===
        "packed"
    ).length;

  const completed =
    list.filter(
      order =>
        order.fulfilmentStatus ===
        "completed"
    ).length;

  const cancelled =
    list.filter(
      order =>
        order.paymentStatus ===
        "cancelled"
    ).length;

  const pendingReviews =
    Number(
      db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM reviews
          WHERE approved = 0
        `)
        .get()
        ?.count ||
      0
    );

  const promo =
    getStorewidePromo();

  return `🛠 KAGE SUPPS ADMIN

Orders:
${list.length}

Payments Waiting:
${awaitingPayments}

Packing:
${packing}

Dispatch:
${dispatch}

Completed:
${completed}

Cancelled:
${cancelled}

Reviews Waiting:
${pendingReviews}

Affiliates:
${PROTECTED_AFFILIATES.length}

Admins:
${allAdminIds().length}

Promo:
${
  promo.active &&
  isStorewidePromoLive(
    promo
  )
    ? `${promo.code} ON`
    : "OFF"
}`;
}

/* =========================================================
   ADMIN KEYBOARD
   ========================================================= */

function adminKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📦 Recent Orders",

            callback_data:
              "admin_recent"
          },

          {
            text:
              "⏳ Payments",

            callback_data:
              "admin_payments"
          }
        ],

        [
          {
            text:
              "🧺 Packing Queue",

            callback_data:
              "admin_packing"
          },

          {
            text:
              "🚚 Dispatch Queue",

            callback_data:
              "admin_dispatch"
          }
        ],

        [
          {
            text:
              "✅ Completed",

            callback_data:
              "admin_completed"
          },

          {
            text:
              "❌ Cancelled",

            callback_data:
              "admin_cancelled"
          }
        ],

        [
          {
            text:
              "🔎 Find Order",

            callback_data:
              "admin_find_order"
          },

          {
            text:
              "👤 Find Customer",

            callback_data:
              "admin_find_customer"
          }
        ],

        [
          {
            text:
              "📊 Reports",

            callback_data:
              "admin_reports"
          },

          {
            text:
              "📦 Stock",

            callback_data:
              "admin_stock"
          }
        ],

        [
          {
            text:
              "⭐ Reviews",

            callback_data:
              "admin_reviews"
          },

          {
            text:
              "🎟 Discounts",

            callback_data:
              "admin_discounts"
          }
        ],

        [
          {
            text:
              "💰 Affiliate Earnings",

            callback_data:
              "admin_earnings"
          },

          {
            text:
              "📢 Announcement",

            callback_data:
              "admin_announcement"
          }
        ],

        [
          {
            text:
              "📜 Activity",

            callback_data:
              "admin_activity"
          },

          {
            text:
              "📥 Export",

            callback_data:
              "admin_export"
          }
        ],

        [
          {
            text:
              "⚙️ Shop Settings",

            callback_data:
              "admin_shop_settings"
          },

          {
            text:
              "👮 Admins",

            callback_data:
              "admin_admins"
          }
        ]
      ]
    }
  };
}

/* =========================================================
   CUSTOMER START MENU
   ========================================================= */

function startKeyboard(
  userId
) {
  const rows =
    [];

  if (
    webAppUrl
  ) {
    rows.push([
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

  rows.push([
    {
      text:
        "📦 My Orders",

      callback_data:
        "customer_orders"
    },

    {
      text:
        "💬 Support",

      callback_data:
        "customer_support"
    }
  ]);

  rows.push([
    {
      text:
        "ℹ️ Info",

      callback_data:
        "customer_info"
    }
  ]);

  if (
    isAdmin(
      userId
    )
  ) {
    rows.push([
      {
        text:
          "🛠 Admin Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);
  }

  return {
    reply_markup: {
      inline_keyboard:
        rows
    }
  };
}

/* =========================================================
   AFFILIATE EARNINGS DISPLAY
   ========================================================= */

function formatAffiliateEarnings() {
  let totalBalance =
    0;

  let totalEarned =
    0;

  let totalPaid =
    0;

  const sections =
    PROTECTED_AFFILIATES.map(
      affiliate => {
        const record =
          referralEarnings.get(
            affiliate.code
          ) ||
          {};

        const balance =
          Number(
            record.balancePence ||
            0
          );

        const earned =
          Number(
            record.totalEarnedPence ||
            0
          );

        const paid =
          Number(
            record.paidOutPence ||
            0
          );

        totalBalance +=
          balance;

        totalEarned +=
          earned;

        totalPaid +=
          paid;

        return `👤 ${affiliate.owner}

Code:
${affiliate.code}

Currently owed:
${money(balance)}

Lifetime earned:
${money(earned)}

Paid out:
${money(paid)}`;
      }
    );

  return `💰 AFFILIATE EARNINGS

${sections.join("\n\n")}

━━━━━━━━━━━━━━

TOTAL CURRENTLY OWED:
${money(totalBalance)}

TOTAL AFFILIATE EARNINGS:
${money(totalEarned)}

TOTAL PAID OUT:
${money(totalPaid)}`;
}

/* =========================================================
   CUSTOMER ORDERS
   ========================================================= */

async function sendCustomerOrders(
  chatId,
  telegramId
) {
  const list =
    getSortedOrders()
      .filter(
        order =>
          String(
            order.telegramId ||
            ""
          ) ===
          String(
            telegramId
          )
      )
      .slice(
        0,
        10
      );

  if (
    !list.length
  ) {
    return safeSendMessage(
      chatId,

      "📦 You don't have any orders linked to this Telegram account yet."
    );
  }

  for (
    const order
    of list
  ) {
    const buttons =
      [];

    if (
      order.paymentStatus ===
        "awaiting_payment" &&
      !order.transactionId
    ) {
      buttons.push([
        {
          text:
            "❌ Cancel Order",

          callback_data:
            `customer_cancel_${order.orderId}`
        }
      ]);
    }

    await safeSendMessage(
      chatId,

`📦 Order #${order.orderId}

${getOrderStatusText(order)}

Total:
${money(order.totalPence)}

${
  order.trackingNumber
    ? `Tracking:
${order.trackingNumber}`
    : ""
}`,

      buttons.length
        ? {
            reply_markup: {
              inline_keyboard:
                buttons
            }
          }
        : undefined
    );
  }
}

/* =========================================================
   REPORTS
   ========================================================= */

function reportForWindow(
  milliseconds = null
) {
  const now =
    Date.now();

  const paidOrders =
    getSortedOrders()
      .filter(
        order => {
          if (
            order.paymentStatus !==
            "paid"
          ) {
            return false;
          }

          const time =
            new Date(
              order.paidAt ||
              order.createdAt ||
              0
            )
              .getTime();

          return (
            milliseconds ===
              null ||
            now -
              time <=
              milliseconds
          );
        }
      );

  const revenue =
    paidOrders.reduce(
      (
        sum,
        order
      ) =>
        sum +
        Number(
          order.totalPence ||
          0
        ),

      0
    );

  const shipping =
    paidOrders.reduce(
      (
        sum,
        order
      ) =>
        sum +
        Number(
          order.shippingPence ||
          0
        ),

      0
    );

  const discounts =
    paidOrders.reduce(
      (
        sum,
        order
      ) =>
        sum +
        Number(
          order.totalDiscountPence ||
          0
        ),

      0
    );

  const itemCounts =
    new Map();

  for (
    const order
    of paidOrders
  ) {
    for (
      const item
      of order.items ||
      []
    ) {
      itemCounts.set(
        item.name,

        Number(
          itemCounts.get(
            item.name
          ) ||
          0
        ) +
        Number(
          item.quantity ||
          0
        )
      );
    }
  }

  const best =
    [
      ...itemCounts.entries()
    ]
      .sort(
        (
          a,
          b
        ) =>
          b[1] -
          a[1]
      )
      .slice(
        0,
        5
      )
      .map(
        (
          [
            name,
            quantity
          ]
        ) =>
          `${name}: ${quantity}`
      )
      .join(
        "\n"
      ) ||
    "No sales";

  return {
    count:
      paidOrders.length,

    revenue,

    shipping,

    discounts,

    average:
      paidOrders.length
        ? Math.round(
            revenue /
            paidOrders.length
          )
        : 0,

    best
  };
}

async function sendReport(
  chatId,
  label,
  milliseconds
) {
  const report =
    reportForWindow(
      milliseconds
    );

  return safeSendMessage(
    chatId,

`📊 ${label}

Paid orders:
${report.count}

Revenue:
${money(report.revenue)}

Average order:
${money(report.average)}

Shipping collected:
${money(report.shipping)}

Discounts given:
${money(report.discounts)}

Best sellers:
${report.best}`
  );
}

/* =========================================================
   REVIEWS ADMIN
   ========================================================= */

async function sendPendingReviews(
  chatId
) {
  const pending =
    db
      .prepare(`
        SELECT
          id,
          order_id,
          display_name,
          rating,
          review_text,
          created_at
        FROM reviews
        WHERE approved = 0
        ORDER BY id ASC
      `)
      .all();

  if (
    !pending.length
  ) {
    return safeSendMessage(
      chatId,

      "⭐ No reviews are waiting for approval."
    );
  }

  for (
    const review
    of pending
  ) {
    const stars =
      "⭐".repeat(
        Math.max(
          1,

          Math.min(
            5,

            Number(
              review.rating ||
              1
            )
          )
        )
      );

    await safeSendMessage(
      chatId,

`⭐ REVIEW #${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

Rating:
${stars}

Review:
${review.review_text}`,

      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text:
                  "✅ Approve",

                callback_data:
                  `review_approve_${review.id}`
              },

              {
                text:
                  "❌ Reject",

                callback_data:
                  `review_reject_${review.id}`
              }
            ]
          ]
        }
      }
    );
  }
}

/* =========================================================
   DISCOUNTS ADMIN
   ========================================================= */

async function sendDiscounts(
  chatId
) {
  const lines =
    [
      ...discountCodes.entries()
    ]
      .sort(
        (
          [a],
          [b]
        ) =>
          a.localeCompare(
            b
          )
      )
      .map(
        (
          [
            code,
            record
          ]
        ) => {
          const amount =
            record.discountType ===
            "percent"
              ? `${record.discountValue}%`
              : money(
                  record.discountValue
                );

          return `• ${code} — ${amount} — ${
            record.active ===
            false
              ? "Inactive"
              : "Active"
          }${
            record.referralOwner
              ? ` — ${record.referralOwner}`
              : ""
          }`;
        }
      );

  const promo =
    getStorewidePromo();

  return safeSendMessage(
    chatId,

`🎟 DISCOUNT CODES

${lines.join("\n") || "No discount codes"}

Storewide Promo:
${promo.code}

Discount:
${promo.discountPercent}%

Enabled:
${promo.active ? "YES" : "NO"}

Live:
${isStorewidePromoLive(promo) ? "YES" : "NO"}`
  );
}

/* =========================================================
   STOCK ADMIN
   ========================================================= */

async function sendStock(
  chatId
) {
  const list =
    getLiveProducts();

  const text =
    list
      .map(
        product =>
          `#${product.id} ${product.name}: ${product.stock}`
      )
      .join(
        "\n"
      );

  return safeSendMessage(
    chatId,

`📦 STOCK

${text || "No products found."}`
  );
}

/* =========================================================
   ACTIVITY ADMIN
   ========================================================= */

async function sendActivity(
  chatId
) {
  const rows =
    db
      .prepare(`
        SELECT
          admin_id,
          action,
          details,
          created_at
        FROM activity_log
        ORDER BY id DESC
        LIMIT 20
      `)
      .all();

  const text =
    rows.length
      ? rows
          .map(
            row =>
`${row.created_at}
${row.action}
${row.details || ""}
Admin: ${row.admin_id || "-"}`
          )
          .join(
            "\n\n"
          )
      : "No admin activity logged yet.";

  return safeSendMessage(
    chatId,

`📜 ACTIVITY

${text}`
  );
}

/* =========================================================
   ADMINS
   ========================================================= */

async function sendAdmins(
  chatId,
  requesterId
) {
  const ids =
    allAdminIds();

  const text =
    ids
      .map(
        id =>
          `${id}${
            id ===
            ownerTelegramId
              ? " — Owner"
              : ""
          }`
      )
      .join(
        "\n"
      );

  const buttons =
    [];

  if (
    isOwner(
      requesterId
    )
  ) {
    buttons.push([
      {
        text:
          "➕ Add Admin",

        callback_data:
          "admin_add_admin"
      },

      {
        text:
          "➖ Remove Admin",

        callback_data:
          "admin_remove_admin"
      }
    ]);
  }

  return safeSendMessage(
    chatId,

`👮 ADMINS

${text || "No admins configured."}`,

    buttons.length
      ? {
          reply_markup: {
            inline_keyboard:
              buttons
          }
        }
      : undefined
  );
}

/* =========================================================
   SHOP SETTINGS
   ========================================================= */

async function sendShopSettings(
  chatId
) {
  const promo =
    getStorewidePromo();

  return safeSendMessage(
    chatId,

`⚙️ SHOP SETTINGS

Accepting Orders:
${acceptingOrders() ? "YES" : "NO"}

Minimum Order:
${money(minimumOrderPence())}

Shipping:
${money(shippingPence())}

Low Stock Threshold:
${lowStockThreshold()}

Storewide Promo:
${promo.code}

Promo Discount:
${promo.discountPercent}%

Promo Enabled:
${promo.active ? "YES" : "NO"}

Promo Live:
${isStorewidePromoLive(promo) ? "YES" : "NO"}`,

    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text:
                acceptingOrders()
                  ? "⏸ Pause Orders"
                  : "▶️ Resume Orders",

              callback_data:
                "admin_shop_toggle"
            },

            {
              text:
                promo.active
                  ? "🔴 Promo OFF"
                  : "🟢 Promo ON",

              callback_data:
                "admin_promo_toggle"
            }
          ],

          [
            {
              text:
                "💷 Minimum",

              callback_data:
                "admin_set_minimum"
            },

            {
              text:
                "🚚 Shipping",

              callback_data:
                "admin_set_shipping"
            }
          ],

          [
            {
              text:
                "📉 Low Stock",

              callback_data:
                "admin_set_lowstock"
            }
          ]
        ]
      }
    }
  );
}

/* =========================================================
   EXPORT
   ========================================================= */

async function sendExport(
  chatId
) {
  if (!bot) {
    return;
  }

  const header =
    [
      "order_id",
      "customer_name",
      "telegram",
      "payment_status",
      "fulfilment_status",
      "subtotal_pence",
      "discount_pence",
      "shipping_pence",
      "total_pence",
      "transaction_id",
      "tracking_number",
      "created_at"
    ]
      .join(
        ","
      );

  const rows =
    getSortedOrders()
      .map(
        order =>
          [
            order.orderId,
            order.customerName,
            order.telegramUsername ||
              order.telegramId ||
              "",
            order.paymentStatus ||
              "",
            order.fulfilmentStatus ||
              "",
            order.subtotalPence ||
              0,
            order.totalDiscountPence ||
              0,
            order.shippingPence ||
              0,
            order.totalPence ||
              0,
            order.transactionId ||
              "",
            order.trackingNumber ||
              "",
            order.createdAt ||
              ""
          ]
            .map(
              csvEscape
            )
            .join(
              ","
            )
      );

  const csv =
    [
      header,
      ...rows
    ]
      .join(
        "\n"
      );

  try {
    await bot.sendDocument(
      chatId,

      Buffer.from(
        csv,
        "utf8"
      ),

      {
        caption:
          "📥 Orders export"
      },

      {
        filename:
          "orders.csv",

        contentType:
          "text/csv"
      }
    );

  } catch (err) {
    console.error(
      "EXPORT ERROR:",
      err?.message ||
      err
    );

    await safeSendMessage(
      chatId,

      "Could not send the export file."
    );
  }
}

/* =========================================================
   PENDING INPUTS
   ========================================================= */

const pendingActions =
  new Map();

const pendingAnnouncements =
  new Map();

function setPending(
  userId,
  action,
  extra = {}
) {
  pendingActions.set(
    String(
      userId
    ),

    {
      action,
      ...extra
    }
  );
}

function clearPending(
  userId
) {
  pendingActions.delete(
    String(
      userId
    )
  );
}

/* =========================================================
   TELEGRAM COMMANDS
   ========================================================= */

if (bot) {
  bot
    .setMyCommands([
      {
        command:
          "start",

        description:
          "Open Kage Supps menu"
      },

      {
        command:
          "myid",

        description:
          "Show your Telegram ID"
      },

      {
        command:
          "admin",

        description:
          "Admin dashboard"
      },

      {
        command:
          "summary",

        description:
          "Admin summary"
      },

      {
        command:
          "reviews",

        description:
          "Approve or reject reviews"
      },

      {
        command:
          "paid",

        description:
          "Mark order paid: /paid 1234"
      },

      {
        command:
          "tracking",

        description:
          "Add tracking: /tracking 1234 TRACKING"
      },

      {
        command:
          "order",

        description:
          "View order: /order 1234"
      },

      {
        command:
          "earnings",

        description:
          "Affiliate earnings"
      },

      {
        command:
          "lowstock",

        description:
          "Low-stock products"
      }
    ])
    .catch(
      () => {}
    );

  /* =======================================================
     /START
     ======================================================= */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,

    async msg => {
      await safeSendMessage(
        msg.chat.id,

`⚡️ KAGE SUPPS

Welcome to Kage Supps.

Use the menu below to open the shop, view your orders or contact support.`,

        startKeyboard(
          msg.from?.id
        )
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

`Your Telegram ID is:

${msg.from?.id}`
      );
    }
  );

  /* =======================================================
     /ADMIN + /SUMMARY
     ======================================================= */

  bot.onText(
    /^\/(?:admin|summary)(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      await safeSendMessage(
        msg.chat.id,

        getAdminSummaryText(),

        adminKeyboard()
      );
    }
  );

  /* =======================================================
     /REVIEWS
     ======================================================= */

  bot.onText(
    /^\/reviews(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      await sendPendingReviews(
        msg.chat.id
      );
    }
  );

  /* =======================================================
     /EARNINGS
     ======================================================= */

  bot.onText(
    /^\/earnings(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      await safeSendMessage(
        msg.chat.id,

        formatAffiliateEarnings()
      );
    }
  );

  /* =======================================================
     /PAID
     ======================================================= */

  bot.onText(
    /^\/paid(?:@\w+)?\s+(\d+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      const order =
        orders.get(
          Number(
            match?.[1]
          )
        );

      if (!order) {
        return safeSendMessage(
          msg.chat.id,

          "Order not found."
        );
      }

      const result =
        await markOrderPaid(
          order,
          msg.from.id
        );

      await safeSendMessage(
        msg.chat.id,

        result.ok
          ? `✅ Order #${order.orderId} marked paid.`
          : `❌ ${result.error}`
      );
    }
  );

  /* =======================================================
     /TRACKING
     ======================================================= */

  bot.onText(
    /^\/tracking(?:@\w+)?\s+(\d+)\s+(.+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      const order =
        orders.get(
          Number(
            match?.[1]
          )
        );

      if (!order) {
        return safeSendMessage(
          msg.chat.id,

          "Order not found."
        );
      }

      const tracking =
        String(
          match?.[2] ||
          ""
        )
          .trim();

      order.trackingNumber =
        tracking;

      order.fulfilmentStatus =
        "shipped";

      order.shippedAt =
        nowIso();

      addTimeline(
        order,
        "shipped",
        msg.from.id,
        tracking
      );

      saveOrder(
        order
      );

      logActivity(
        msg.from.id,
        "tracking",
        `Order #${order.orderId}: ${tracking}`
      );

      await safeSendMessage(
        msg.chat.id,

        `🚚 Tracking saved for order #${order.orderId}.`
      );

      if (
        order.telegramId
      ) {
        await safeSendMessage(
          order.telegramId,

`🚚 Order #${order.orderId} has been dispatched.

Tracking:
${tracking}`
        );
      }
    }
  );

  /* =======================================================
     /ORDER
     ======================================================= */

  bot.onText(
    /^\/order(?:@\w+)?\s+(\d+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      const order =
        orders.get(
          Number(
            match?.[1]
          )
        );

      if (!order) {
        return safeSendMessage(
          msg.chat.id,

          "Order not found."
        );
      }

      await safeSendMessage(
        msg.chat.id,

        formatOrderAdmin(
          order
        )
      );
    }
  );

  /* =======================================================
     /LOWSTOCK
     ======================================================= */

  bot.onText(
    /^\/lowstock(?:@\w+)?$/i,

    async msg => {
      if (
        !isAdmin(
          msg.from?.id
        )
      ) {
        return;
      }

      const threshold =
        lowStockThreshold();

      const list =
        getLiveProducts()
          .filter(
            product =>
              Number(
                product.stock
              ) <=
              threshold
          );

      await safeSendMessage(
        msg.chat.id,

        list.length
          ? `📉 LOW STOCK

${list
  .map(
    product =>
      `#${product.id} ${product.name}: ${product.stock}`
  )
  .join("\n")}`
          : "✅ No products are currently below the low-stock threshold."
      );
    }
  );

  /* =======================================================
     OWNER ADMIN COMMANDS
     ======================================================= */

  bot.onText(
    /^\/addadmin(?:@\w+)?\s+(\d+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isOwner(
          msg.from?.id
        )
      ) {
        return;
      }

      const id =
        String(
          match?.[1]
        );

      insertAdminStmt.run(
        id,
        nowIso(),
        String(
          msg.from.id
        )
      );

      logActivity(
        msg.from.id,
        "add_admin",
        id
      );

      await safeSendMessage(
        msg.chat.id,

        `✅ ${id} added as an admin.`
      );
    }
  );

  bot.onText(
    /^\/removeadmin(?:@\w+)?\s+(\d+)$/i,

    async (
      msg,
      match
    ) => {
      if (
        !isOwner(
          msg.from?.id
        )
      ) {
        return;
      }

      const id =
        String(
          match?.[1]
        );

      if (
        id ===
        ownerTelegramId
      ) {
        return safeSendMessage(
          msg.chat.id,

          "The owner cannot be removed."
        );
      }

      deleteAdminStmt.run(
        id
      );

      logActivity(
        msg.from.id,
        "remove_admin",
        id
      );

      await safeSendMessage(
        msg.chat.id,

        `✅ ${id} removed from admins.`
      );
    }
  );

  /* =======================================================
     CALLBACKS
     ======================================================= */

  bot.on(
    "callback_query",

    async query => {
      const chatId =
        query.message?.chat?.id;

      const data =
        String(
          query.data ||
          ""
        );

      const userId =
        query.from?.id;

      if (!chatId) {
        return;
      }

      try {
        await bot
          .answerCallbackQuery(
            query.id
          );

      } catch {}

      /* CUSTOMER INFO */

      if (
        data ===
        "customer_info"
      ) {
        return safeSendMessage(
          chatId,

`ℹ️ KAGE SUPPS

🛍 Open Shop to browse the catalogue.

📦 My Orders shows orders linked to your Telegram account.

💬 Support lets you contact the support team.`
        );
      }

      /* SUPPORT */

      if (
        data ===
        "customer_support"
      ) {
        return safeSendMessage(
          chatId,

`💬 KAGE SUPPS SUPPORT

Need help with an order?

Main Support:
@KageSupps

Alternative Support:
@SuperSeiyanGoku33

Please include your order number when messaging support.`
        );
      }

      /* CUSTOMER ORDERS */

      if (
        data ===
        "customer_orders"
      ) {
        return sendCustomerOrders(
          chatId,
          userId
        );
      }

      /* CANCEL ORDER */

      if (
        data.startsWith(
          "customer_cancel_"
        ) &&
        !data.startsWith(
          "customer_cancel_confirm_"
        )
      ) {
        const orderId =
          Number(
            data.replace(
              "customer_cancel_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order ||
          String(
            order.telegramId ||
            ""
          ) !==
            String(
              userId
            )
        ) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        if (
          order.paymentStatus !==
            "awaiting_payment" ||
          order.transactionId
        ) {
          return safeSendMessage(
            chatId,

            "This order can no longer be cancelled automatically."
          );
        }

        return safeSendMessage(
          chatId,

          `Cancel order #${order.orderId}?`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "✅ Yes, cancel it",

                    callback_data:
                      `customer_cancel_confirm_${order.orderId}`
                  },

                  {
                    text:
                      "↩️ Keep Order",

                    callback_data:
                      "customer_orders"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data.startsWith(
          "customer_cancel_confirm_"
        )
      ) {
        const orderId =
          Number(
            data.replace(
              "customer_cancel_confirm_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order ||
          String(
            order.telegramId ||
            ""
          ) !==
            String(
              userId
            )
        ) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        if (
          order.paymentStatus !==
            "awaiting_payment" ||
          order.transactionId
        ) {
          return safeSendMessage(
            chatId,

            "This order can no longer be cancelled automatically."
          );
        }

        order.paymentStatus =
          "cancelled";

        order.fulfilmentStatus =
          "cancelled";

        order.cancelledAt =
          nowIso();

        addTimeline(
          order,
          "cancelled",
          userId,
          "Cancelled by customer"
        );

        saveOrder(
          order
        );

        await sendToAdmins(
`❌ ORDER CANCELLED BY CUSTOMER

#${order.orderId}

${order.customerName}`
        );

        return safeSendMessage(
          chatId,

          `❌ Order #${order.orderId} has been cancelled.`
        );
      }

      /* ADMIN ONLY */

      if (
        !isAdmin(
          userId
        )
      ) {
        return;
      }

      if (
        data ===
        "admin_dashboard"
      ) {
        return safeSendMessage(
          chatId,

          getAdminSummaryText(),

          adminKeyboard()
        );
      }

      /* RECENT ORDERS */

      if (
        data ===
        "admin_recent"
      ) {
        const list =
          getSortedOrders()
            .slice(
              0,
              10
            );

        return safeSendMessage(
          chatId,

          list.length
            ? `📦 RECENT ORDERS

${list
  .map(
    order =>
      `#${order.orderId} • ${order.customerName} • ${getOrderStatusText(order)} • ${money(order.totalPence)}`
  )
  .join("\n")}`
            : "No orders yet."
        );
      }

      /* PAYMENTS */

      if (
        data ===
        "admin_payments"
      ) {
        const list =
          getSortedOrders()
            .filter(
              order =>
                order.paymentStatus ===
                "payment_submitted"
            );

        if (
          !list.length
        ) {
          return safeSendMessage(
            chatId,

            "⏳ No submitted payments are waiting."
          );
        }

        for (
          const order
          of list.slice(
            0,
            20
          )
        ) {
          const itemText =
            formatItems(
              order
            );

          await safeSendMessage(
            chatId,

`⏳ PAYMENT WAITING

#${order.orderId}

${order.customerName}

🛒 ITEMS:
${itemText || "No item details saved"}

Total:
${money(order.totalPence)}

TX:
${order.transactionId || "-"}`,

            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "✅ Mark Paid",

                      callback_data:
                        `admin_paid_${order.orderId}`
                    }
                  ]
                ]
              }
            }
          );
        }

        return;
      }

      if (
        data.startsWith(
          "admin_paid_"
        )
      ) {
        const order =
          orders.get(
            Number(
              data.replace(
                "admin_paid_",
                ""
              )
            )
          );

        if (!order) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        const result =
          await markOrderPaid(
            order,
            userId
          );

        return safeSendMessage(
          chatId,

          result.ok
            ? `✅ Order #${order.orderId} marked paid.`
            : `❌ ${result.error}`
        );
      }

      /* PACKING */

      if (
        data ===
        "admin_packing"
      ) {
        const list =
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "needs_packing"
            );

        if (
          !list.length
        ) {
          return safeSendMessage(
            chatId,

            "🧺 Packing queue is empty."
          );
        }

        for (
          const order
          of list.slice(
            0,
            20
          )
        ) {
          const itemText =
            formatItems(
              order
            );

          await safeSendMessage(
            chatId,

`🧺 ORDER #${order.orderId}

${order.customerName}

🛒 ITEMS:
${itemText || "No item details saved"}

Total:
${money(order.totalPence)}`,

            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "📦 Mark Packed",

                      callback_data:
                        `admin_pack_${order.orderId}`
                    }
                  ]
                ]
              }
            }
          );
        }

        return;
      }

      if (
        data.startsWith(
          "admin_pack_"
        )
      ) {
        const order =
          orders.get(
            Number(
              data.replace(
                "admin_pack_",
                ""
              )
            )
          );

        if (!order) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        if (
          order.paymentStatus !==
          "paid"
        ) {
          return safeSendMessage(
            chatId,

            "Order must be paid first."
          );
        }

        order.fulfilmentStatus =
          "packed";

        order.packedAt =
          nowIso();

        addTimeline(
          order,
          "packed",
          userId,
          "Marked packed"
        );

        saveOrder(
          order
        );

        logActivity(
          userId,
          "packed",
          `Order #${order.orderId}`
        );

        return safeSendMessage(
          chatId,

          `📦 Order #${order.orderId} marked packed.`
        );
      }

      /* DISPATCH */

      if (
        data ===
        "admin_dispatch"
      ) {
        const list =
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "packed"
            );

        if (
          !list.length
        ) {
          return safeSendMessage(
            chatId,

            "🚚 Dispatch queue is empty."
          );
        }

        for (
          const order
          of list.slice(
            0,
            20
          )
        ) {
          const itemText =
            formatItems(
              order
            );

          await safeSendMessage(
            chatId,

`🚚 ORDER #${order.orderId}

${order.customerName}

🛒 ITEMS:
${itemText || "No item details saved"}`,

            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text:
                        "➕ Add Tracking",

                      callback_data:
                        `admin_tracking_${order.orderId}`
                    }
                  ]
                ]
              }
            }
          );
        }

        return;
      }

      if (
        data.startsWith(
          "admin_tracking_"
        )
      ) {
        const orderId =
          Number(
            data.replace(
              "admin_tracking_",
              ""
            )
          );

        if (
          !orders.has(
            orderId
          )
        ) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        setPending(
          userId,
          "tracking",

          {
            orderId,
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          `Send the tracking number for order #${orderId}.`
        );
      }

      /* COMPLETED */

      if (
        data ===
        "admin_completed"
      ) {
        const list =
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "completed"
            );

        return safeSendMessage(
          chatId,

          list.length
            ? `✅ COMPLETED

${list
  .slice(
    0,
    20
  )
  .map(
    order =>
      `#${order.orderId} • ${order.customerName}`
  )
  .join("\n")}`
            : "✅ No completed orders yet."
        );
      }

      /* CANCELLED */

      if (
        data ===
        "admin_cancelled"
      ) {
        const list =
          getSortedOrders()
            .filter(
              order =>
                order.paymentStatus ===
                "cancelled"
            );

        return safeSendMessage(
          chatId,

          list.length
            ? `❌ CANCELLED

${list
  .slice(
    0,
    20
  )
  .map(
    order =>
      `#${order.orderId} • ${order.customerName}`
  )
  .join("\n")}`
            : "❌ No cancelled orders."
        );
      }

      /* FIND ORDER */

      if (
        data ===
        "admin_find_order"
      ) {
        setPending(
          userId,
          "find_order",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the order number you want to find."
        );
      }

      /* FIND CUSTOMER */

      if (
        data ===
        "admin_find_customer"
      ) {
        setPending(
          userId,
          "find_customer",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the customer's name, Telegram username or Telegram ID."
        );
      }

      /* REPORTS */

      if (
        data ===
        "admin_reports"
      ) {
        return safeSendMessage(
          chatId,

          "📊 REPORTS",

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "24 Hours",

                    callback_data:
                      "admin_report_24h"
                  },

                  {
                    text:
                      "7 Days",

                    callback_data:
                      "admin_report_7d"
                  }
                ],

                [
                  {
                    text:
                      "30 Days",

                    callback_data:
                      "admin_report_30d"
                  },

                  {
                    text:
                      "All Time",

                    callback_data:
                      "admin_report_all"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data ===
        "admin_report_24h"
      ) {
        return sendReport(
          chatId,
          "LAST 24 HOURS",
          24 *
          60 *
          60 *
          1000
        );
      }

      if (
        data ===
        "admin_report_7d"
      ) {
        return sendReport(
          chatId,
          "LAST 7 DAYS",
          7 *
          24 *
          60 *
          60 *
          1000
        );
      }

      if (
        data ===
        "admin_report_30d"
      ) {
        return sendReport(
          chatId,
          "LAST 30 DAYS",
          30 *
          24 *
          60 *
          60 *
          1000
        );
      }

      if (
        data ===
        "admin_report_all"
      ) {
        return sendReport(
          chatId,
          "ALL TIME",
          null
        );
      }

      /* STOCK */

      if (
        data ===
        "admin_stock"
      ) {
        return sendStock(
          chatId
        );
      }

      /* REVIEWS */

      if (
        data ===
        "admin_reviews"
      ) {
        return sendPendingReviews(
          chatId
        );
      }

      if (
        data.startsWith(
          "review_approve_"
        )
      ) {
        const reviewId =
          Number(
            data.replace(
              "review_approve_",
              ""
            )
          );

        const review =
          db
            .prepare(`
              SELECT *
              FROM reviews
              WHERE id = ?
            `)
            .get(
              reviewId
            );

        if (!review) {
          return safeSendMessage(
            chatId,

            "Review not found."
          );
        }

        db
          .prepare(`
            UPDATE reviews
            SET approved = 1
            WHERE id = ?
          `)
          .run(
            reviewId
          );

        logActivity(
          userId,
          "review_approved",
          `Review #${reviewId}`
        );

        return safeSendMessage(
          chatId,

          `✅ Review #${reviewId} approved.`
        );
      }

      if (
        data.startsWith(
          "review_reject_"
        )
      ) {
        const reviewId =
          Number(
            data.replace(
              "review_reject_",
              ""
            )
          );

        const review =
          db
            .prepare(`
              SELECT *
              FROM reviews
              WHERE id = ?
            `)
            .get(
              reviewId
            );

        if (!review) {
          return safeSendMessage(
            chatId,

            "Review not found."
          );
        }

        db
          .prepare(`
            DELETE FROM reviews
            WHERE id = ?
          `)
          .run(
            reviewId
          );

        logActivity(
          userId,
          "review_rejected",
          `Review #${reviewId}`
        );

        return safeSendMessage(
          chatId,

          `❌ Review #${reviewId} rejected and removed.`
        );
      }

      /* DISCOUNTS */

      if (
        data ===
        "admin_discounts"
      ) {
        return sendDiscounts(
          chatId
        );
      }

      /* AFFILIATE EARNINGS */

      if (
        data ===
        "admin_earnings"
      ) {
        return safeSendMessage(
          chatId,

          formatAffiliateEarnings()
        );
      }

      /* ANNOUNCEMENT */

      if (
        data ===
        "admin_announcement"
      ) {
        setPending(
          userId,
          "announcement",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the announcement text. I'll show you a preview before it is sent."
        );
      }

      if (
        data ===
        "admin_announcement_confirm"
      ) {
        const announcement =
          pendingAnnouncements.get(
            String(
              userId
            )
          );

        if (!announcement) {
          return safeSendMessage(
            chatId,

            "No announcement is waiting for confirmation."
          );
        }

        const recipients =
          [
            ...new Set(
              [
                ...orders.values()
              ]
                .map(
                  order =>
                    String(
                      order.telegramId ||
                      ""
                    )
                      .trim()
                )
                .filter(
                  Boolean
                )
            )
          ];

        let sent =
          0;

        for (
          const id
          of recipients
        ) {
          const result =
            await safeSendMessage(
              id,

`📢 KAGE SUPPS

${announcement.text}`
            );

          if (result) {
            sent +=
              1;
          }
        }

        pendingAnnouncements.delete(
          String(
            userId
          )
        );

        logActivity(
          userId,
          "announcement",
          `Sent to ${sent} customers`
        );

        return safeSendMessage(
          chatId,

          `📢 Announcement sent to ${sent} customers.`
        );
      }

      if (
        data ===
        "admin_announcement_cancel"
      ) {
        pendingAnnouncements.delete(
          String(
            userId
          )
        );

        return safeSendMessage(
          chatId,

          "Announcement cancelled."
        );
      }

      /* ACTIVITY */

      if (
        data ===
        "admin_activity"
      ) {
        return sendActivity(
          chatId
        );
      }

      /* EXPORT */

      if (
        data ===
        "admin_export"
      ) {
        return sendExport(
          chatId
        );
      }

      /* SHOP SETTINGS */

      if (
        data ===
        "admin_shop_settings"
      ) {
        return sendShopSettings(
          chatId
        );
      }

      if (
        data ===
        "admin_shop_toggle"
      ) {
        const active =
          acceptingOrders();

        setMetaValue(
          "setting:acceptingOrders",

          active
            ? "false"
            : "true"
        );

        logActivity(
          userId,
          "shop_toggle",

          active
            ? "paused"
            : "resumed"
        );

        return sendShopSettings(
          chatId
        );
      }

      if (
        data ===
        "admin_promo_toggle"
      ) {
        const promo =
          getStorewidePromo();

        setMetaValue(
          "storewidePromo:active",

          promo.active
            ? "false"
            : "true"
        );

        logActivity(
          userId,
          "promo_toggle",

          promo.active
            ? "off"
            : "on"
        );

        return sendShopSettings(
          chatId
        );
      }

      if (
        data ===
        "admin_set_minimum"
      ) {
        setPending(
          userId,
          "set_minimum",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the new minimum order in pounds, e.g. 50"
        );
      }

      if (
        data ===
        "admin_set_shipping"
      ) {
        setPending(
          userId,
          "set_shipping",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the new shipping charge in pounds, e.g. 5"
        );
      }

      if (
        data ===
        "admin_set_lowstock"
      ) {
        setPending(
          userId,
          "set_lowstock",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the new low-stock threshold, e.g. 5"
        );
      }

      /* ADMINS */

      if (
        data ===
        "admin_admins"
      ) {
        return sendAdmins(
          chatId,
          userId
        );
      }

      if (
        data ===
        "admin_add_admin"
      ) {
        if (
          !isOwner(
            userId
          )
        ) {
          return;
        }

        setPending(
          userId,
          "add_admin",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the Telegram ID to add as an admin."
        );
      }

      if (
        data ===
        "admin_remove_admin"
      ) {
        if (
          !isOwner(
            userId
          )
        ) {
          return;
        }

        setPending(
          userId,
          "remove_admin",

          {
            chatId
          }
        );

        return safeSendMessage(
          chatId,

          "Send the Telegram ID to remove."
        );
      }
    }
  );

  /* =======================================================
     ADMIN TEXT INPUT
     ======================================================= */

  bot.on(
    "message",

    async msg => {
      const userId =
        msg.from?.id;

      const chatId =
        msg.chat?.id;

      const text =
        String(
          msg.text ||
          ""
        )
          .trim();

      if (
        !userId ||
        !chatId ||
        !text ||
        text.startsWith(
          "/"
        )
      ) {
        return;
      }

      const pending =
        pendingActions.get(
          String(
            userId
          )
        );

      if (
        !pending ||
        !isAdmin(
          userId
        )
      ) {
        return;
      }

      clearPending(
        userId
      );

      if (
        pending.action ===
        "find_order"
      ) {
        const order =
          orders.get(
            Number(
              text
            )
          );

        return safeSendMessage(
          chatId,

          order
            ? formatOrderAdmin(
                order
              )
            : "Order not found."
        );
      }

      if (
        pending.action ===
        "find_customer"
      ) {
        const matches =
          getSortedOrders()
            .filter(
              order =>
                orderMatchesCustomer(
                  order,
                  text
                )
            )
            .slice(
              0,
              15
            );

        return safeSendMessage(
          chatId,

          matches.length
            ? `👤 CUSTOMER RESULTS

${matches
  .map(
    order =>
      `#${order.orderId} • ${order.customerName} • ${order.telegramUsername || order.telegramId || "-"} • ${money(order.totalPence)}`
  )
  .join("\n")}`
            : "No matching customer or order was found."
        );
      }

      if (
        pending.action ===
        "tracking"
      ) {
        const order =
          orders.get(
            Number(
              pending.orderId
            )
          );

        if (!order) {
          return safeSendMessage(
            chatId,

            "Order not found."
          );
        }

        order.trackingNumber =
          text;

        order.fulfilmentStatus =
          "shipped";

        order.shippedAt =
          nowIso();

        addTimeline(
          order,
          "shipped",
          userId,
          text
        );

        saveOrder(
          order
        );

        logActivity(
          userId,
          "tracking",
          `Order #${order.orderId}: ${text}`
        );

        if (
          order.telegramId
        ) {
          await safeSendMessage(
            order.telegramId,

`🚚 Order #${order.orderId} has been dispatched.

Tracking:
${text}`
          );
        }

        return safeSendMessage(
          chatId,

          `🚚 Tracking saved for order #${order.orderId}.`
        );
      }

      if (
        pending.action ===
        "announcement"
      ) {
        pendingAnnouncements.set(
          String(
            userId
          ),

          {
            text
          }
        );

        return safeSendMessage(
          chatId,

`📢 ANNOUNCEMENT PREVIEW

${text}`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "✅ Send",

                    callback_data:
                      "admin_announcement_confirm"
                  },

                  {
                    text:
                      "❌ Cancel",

                    callback_data:
                      "admin_announcement_cancel"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        pending.action ===
        "set_minimum"
      ) {
        const pounds =
          Number(
            text
          );

        if (
          !Number.isFinite(
            pounds
          ) ||
          pounds <
            0
        ) {
          return safeSendMessage(
            chatId,

            "Enter a valid amount in pounds."
          );
        }

        const pence =
          Math.round(
            pounds *
            100
          );

        setMetaValue(
          "setting:minimumOrderPence",
          pence
        );

        logActivity(
          userId,
          "set_minimum",
          money(
            pence
          )
        );

        return sendShopSettings(
          chatId
        );
      }

      if (
        pending.action ===
        "set_shipping"
      ) {
        const pounds =
          Number(
            text
          );

        if (
          !Number.isFinite(
            pounds
          ) ||
          pounds <
            0
        ) {
          return safeSendMessage(
            chatId,

            "Enter a valid amount in pounds."
          );
        }

        const pence =
          Math.round(
            pounds *
            100
          );

        setMetaValue(
          "setting:shippingPence",
          pence
        );

        logActivity(
          userId,
          "set_shipping",
          money(
            pence
          )
        );

        return sendShopSettings(
          chatId
        );
      }

      if (
        pending.action ===
        "set_lowstock"
      ) {
        const threshold =
          Number(
            text
          );

        if (
          !Number.isInteger(
            threshold
          ) ||
          threshold <
            0
        ) {
          return safeSendMessage(
            chatId,

            "Enter a whole number, e.g. 5"
          );
        }

        setMetaValue(
          "setting:lowStockThreshold",
          threshold
        );

        logActivity(
          userId,
          "set_lowstock",
          String(
            threshold
          )
        );

        return sendShopSettings(
          chatId
        );
      }

      if (
        pending.action ===
        "add_admin"
      ) {
        if (
          !isOwner(
            userId
          )
        ) {
          return;
        }

        if (
          !/^\d+$/.test(
            text
          )
        ) {
          return safeSendMessage(
            chatId,

            "Send a numeric Telegram ID."
          );
        }

        insertAdminStmt.run(
          text,
          nowIso(),
          String(
            userId
          )
        );

        logActivity(
          userId,
          "add_admin",
          text
        );

        return sendAdmins(
          chatId,
          userId
        );
      }

      if (
        pending.action ===
        "remove_admin"
      ) {
        if (
          !isOwner(
            userId
          )
        ) {
          return;
        }

        if (
          !/^\d+$/.test(
            text
          )
        ) {
          return safeSendMessage(
            chatId,

            "Send a numeric Telegram ID."
          );
        }

        if (
          text ===
          ownerTelegramId
        ) {
          return safeSendMessage(
            chatId,

            "The owner cannot be removed."
          );
        }

        deleteAdminStmt.run(
          text
        );

        logActivity(
          userId,
          "remove_admin",
          text
        );

        return sendAdmins(
          chatId,
          userId
        );
      }
    }
  );
}

/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
  port,
  "0.0.0.0",

  () => {
    console.log(
      `Storefront running on port ${port}`
    );

    console.log(
      `Products: ${products.length}`
    );

    console.log(
      `Minimum basket: ${money(
        minimumOrderPence()
      )}`
    );

    console.log(
      `Shipping: ${money(
        shippingPence()
      )}`
    );

    console.log(
      `Admins: ${
        allAdminIds()
          .join(", ") ||
        "none"
      }`
    );
  }
);