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

const supportTelegramIds = (
  process.env.SUPPORT_TELEGRAM_IDS ||
  ""
)
  .split(",")
  .map(v => v.trim())
  .filter(Boolean);

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
    order.timeline = [];
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
    ) === null
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
      ok: true
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

      const items = [];

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

      /*
       Affiliate and storewide discounts are both calculated
       from the ORIGINAL basket subtotal.

       10% affiliate + 10% WEEKEND10 = exactly 20%.
      */

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

      await sendToAdmins(
`🆕 NEW ORDER #${orderId}

Customer: ${customerName}
Telegram: ${telegramUsername || telegramId || "Not supplied"}

Subtotal:
${money(subtotalPence)}

Affiliate saving:
${money(affiliateDiscountPence)}

Store promo saving:
${money(storewideDiscountPence)}

Total saving:
${money(totalDiscountPence)}

Shipping:
${money(deliveryPence)}

TOTAL:
${money(totalPence)}

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
   SUBMIT TRANSACTION HASH
   DOES NOT MARK PAYMENT AS PAID
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

    sendToAdmins(
`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

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
   STOCK HELPERS
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
   MARK PAID
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
   REVIEWS
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

    return await bot
      .sendMessage(
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

function adminKeyboard() {

  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text:
              "📦 Packing Queue",

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
              "💰 Affiliate Earnings",

            callback_data:
              "admin_earnings"
          },
          {
            text:
              "🎉 Storewide Promo",

            callback_data:
              "admin_promo"
          }
        ],
        [
          {
            text:
              "📉 Low Stock",

            callback_data:
              "admin_lowstock"
          },
          {
            text:
              "⚙️ Shop Status",

            callback_data:
              "admin_shop_status"
          }
        ]
      ]
    }
  };
}

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

function formatAffiliateEarnings() {

  let totalBalance =
    0;

  let totalEarned =
    0;

  let totalPaid =
    0;

  const sections =
    PROTECTED_AFFILIATES
      .map(
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
Code: ${affiliate.code}
Owed: ${money(balance)}
Lifetime: ${money(earned)}
Paid: ${money(paid)}`;
        }
      );

  return `💰 AFFILIATE EARNINGS

${sections.join("\n\n")}

━━━━━━━━━━━━━━

Currently owed:
${money(totalBalance)}

Lifetime earned:
${money(totalEarned)}

Paid out:
${money(totalPaid)}`;
}

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

  const text =
    list
      .map(
        order =>
`#${order.orderId}
${getOrderStatusText(order)}
${money(order.totalPence)}`
      )
      .join(
        "\n\n"
      );

  return safeSendMessage(
    chatId,
    `📦 YOUR ORDERS\n\n${text}`
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
     /ADMIN
     ======================================================= */

  bot.onText(
    /^\/admin(?:@\w+)?$/i,

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
        "🛠 KAGE SUPPS ADMIN",
        adminKeyboard()
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

`📦 ORDER #${order.orderId}

Customer:
${order.customerName}

Telegram:
${order.telegramUsername || order.telegramId || "-"}

Status:
${getOrderStatusText(order)}

Subtotal:
${money(order.subtotalPence)}

Affiliate saving:
${money(order.affiliateDiscountPence)}

Promo saving:
${money(order.storewideDiscountPence)}

Shipping:
${money(order.shippingPence)}

Total:
${money(order.totalPence)}

TX:
${order.transactionId || "Not submitted"}

Tracking:
${order.trackingNumber || "Not added"}

Address:
${order.address}`
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
     OWNER ADMIN MANAGEMENT
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

      await safeSendMessage(
        msg.chat.id,

        `✅ ${id} removed from admins.`
      );
    }
  );

  /* =======================================================
     CALLBACK BUTTONS
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

        const supportText =
          supportTelegramIds.length
            ? `💬 SUPPORT

Please contact support and include your order number.

Support IDs:
${supportTelegramIds.join(", ")}`
            : `💬 SUPPORT

Please send a message with your order number and what you need help with.`;

        return safeSendMessage(
          chatId,
          supportText
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

      /* ADMIN ONLY BELOW */

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
          "🛠 KAGE SUPPS ADMIN",
          adminKeyboard()
        );
      }

      if (
        data ===
        "admin_earnings"
      ) {

        return safeSendMessage(
          chatId,
          formatAffiliateEarnings()
        );
      }

      if (
        data ===
        "admin_promo"
      ) {

        const promo =
          getStorewidePromo();

        return safeSendMessage(
          chatId,

`🎉 STOREWIDE PROMO

Code:
${promo.code}

Discount:
${promo.discountPercent}%

Enabled:
${promo.active ? "YES" : "NO"}

Live now:
${isStorewidePromoLive(promo) ? "YES" : "NO"}

Ends:
${promo.endsAt}`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      promo.active
                        ? "🔴 Switch OFF"
                        : "🟢 Switch ON",

                    callback_data:
                      "admin_promo_toggle"
                  }
                ]
              ]
            }
          }
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

        return safeSendMessage(
          chatId,

          `🎉 Storewide promo is now ${promo.active ? "OFF" : "ON"}.`
        );
      }

      if (
        data ===
        "admin_shop_status"
      ) {

        const active =
          acceptingOrders();

        return safeSendMessage(
          chatId,

`⚙️ SHOP STATUS

Accepting orders:
${active ? "YES" : "NO"}`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      active
                        ? "⏸ Pause Orders"
                        : "▶️ Resume Orders",

                    callback_data:
                      "admin_shop_toggle"
                  }
                ]
              ]
            }
          }
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

        return safeSendMessage(
          chatId,

          active
            ? "⏸ Shop paused."
            : "▶️ Shop is accepting orders again."
        );
      }

      if (
        data ===
        "admin_lowstock"
      ) {

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

        return safeSendMessage(
          chatId,

          list.length
            ? `📉 LOW STOCK

${list
  .map(
    product =>
      `#${product.id} ${product.name}: ${product.stock}`
  )
  .join("\n")}`
            : "✅ No low-stock products."
        );
      }

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
            )
            .slice(
              0,
              20
            );

        return safeSendMessage(
          chatId,

          list.length
            ? `📦 PACKING QUEUE

${list
  .map(
    order =>
      `#${order.orderId} • ${order.customerName} • ${money(order.totalPence)}`
  )
  .join("\n")}`
            : "📦 Packing queue is empty."
        );
      }

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
            )
            .slice(
              0,
              20
            );

        return safeSendMessage(
          chatId,

          list.length
            ? `🚚 DISPATCH QUEUE

${list
  .map(
    order =>
      `#${order.orderId} • ${order.customerName}`
  )
  .join("\n")}`
            : "🚚 Dispatch queue is empty."
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