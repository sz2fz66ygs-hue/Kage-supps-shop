import "dotenv/config";
import { readFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { randomUUID } from "crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

/* =========================================================
   BASIC APP
   ========================================================= */

const __dirname =
  path.dirname(
    fileURLToPath(import.meta.url)
  );

const app =
  express();

const port =
  Number(
    process.env.PORT ||
    3000
  );

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

const etherscanApiKey =
  process.env.ETHERSCAN ||
  process.env.ETHERSCAN_API_KEY ||
  "";

const webAppUrl =
  process.env.WEBAPP_URL ||
  "";

const DATA_DIR =
  process.env.DATA_DIR ||
  ".";

/* =========================================================
   ADMINS
   ========================================================= */

const ownerTelegramId =
  String(
    process.env.OWNER_TELEGRAM_ID ||
    ""
  ).trim();

const singleAdminId =
  String(
    process.env.ADMIN_TELEGRAM_ID ||
    ""
  ).trim();

const adminIdsFromEnv =
  String(
    process.env.ADMIN_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(
      id =>
        id.trim()
    )
    .filter(Boolean);

const configuredAdminIds =
  new Set(
    [
      ownerTelegramId,
      singleAdminId,
      ...adminIdsFromEnv
    ]
      .map(String)
      .map(
        id =>
          id.trim()
      )
      .filter(Boolean)
  );

/*
  Kept for old parts of the app which expect
  one primary admin ID.
*/

const adminTelegramId =
  ownerTelegramId ||
  singleAdminId ||
  adminIdsFromEnv[0] ||
  "";

/* =========================================================
   SUPPORT
   ========================================================= */

const supportTelegramIds =
  String(
    process.env.SUPPORT_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(
      id =>
        id.trim()
    )
    .filter(Boolean);

/* =========================================================
   SHOP SETTINGS
   ========================================================= */

const MINIMUM_ORDER_PENCE =
  5000;

const SHIPPING_PENCE =
  500;

const LOW_STOCK_THRESHOLD =
  5;

/*
  Stock is reserved for 30 minutes once
  the customer actually creates the order.

  Merely adding something to the basket
  does NOT reserve it.
*/

const STOCK_RESERVATION_MINUTES =
  30;

const STOCK_RESERVATION_MS =
  STOCK_RESERVATION_MINUTES *
  60 *
  1000;

/* =========================================================
   AFFILIATE / REFERRAL CODES
   ========================================================= */

const AFFILIATE_DISCOUNT_PERCENT = 10;
const AFFILIATE_COMMISSION_PERCENT = 5;

const affiliateCodes = [
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
  },

  {
    code: "JAM97",
    owner: "@Jam97"
  }
];

/* =========================================================
   STORE-WIDE PROMO
   ========================================================= */

const STOREWIDE_PROMO_DEFAULTS = {
  code:
    "WEEKEND10",

  discountPercent:
    10,

  active:
    true,

  startsAt:
    "2026-10-03T00:00:00+01:00",

  endsAt:
    "2026-10-05T23:59:59+01:00"
};

/* =========================================================
   EXPRESS
   ========================================================= */

app.use(
  express.json({
    limit:
      "1mb"
  })
);

/* =========================================================
   DATABASE
   ========================================================= */

mkdirSync(
  DATA_DIR,
  {
    recursive:
      true
  }
);

const db =
  new DatabaseSync(
    path.join(
      DATA_DIR,
      "kage.sqlite"
    )
  );

/*
  IMPORTANT:
  This does NOT delete your existing database.

  CREATE TABLE IF NOT EXISTS only creates
  missing tables.
*/

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
  stock INTEGER NOT NULL DEFAULT 0
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

/*
  Atomic stock reservation.

  Stock is only reduced when enough
  stock is actually available.
*/

const reserveInventoryStmt =
  db.prepare(`
    UPDATE inventory
    SET stock = stock - ?
    WHERE product_id = ?
      AND stock >= ?
  `);

const restoreInventoryStmt =
  db.prepare(`
    UPDATE inventory
    SET stock = stock + ?
    WHERE product_id = ?
  `);

/* =========================================================
   PRODUCT CATALOGUE
   ========================================================= */

let products =
  [];

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

  if (
    !Array.isArray(
      products
    )
  ) {

    throw new Error(
      "products.json must contain an array."
    );
  }

} catch (
  err
) {

  console.error(
    "PRODUCT LOAD ERROR:",
    err
  );

  process.exit(
    1
  );
}

const productsById =
  new Map(
    products.map(
      product => [
        Number(
          product.id
        ),
        product
      ]
    )
  );

/* =========================================================
   INITIALISE LIVE INVENTORY
   ========================================================= */

/*
  Existing database stock is preserved.

  products.json only gives the INITIAL
  stock value for products that have never
  been put into SQLite before.
*/

for (
  const product
  of products
) {

  const id =
    Number(
      product.id
    );

  const originalStock =
    Number(
      product.stock
    );

  if (
    !Number.isInteger(
      id
    )
  ) {
    continue;
  }

  if (
    Number.isFinite(
      originalStock
    )
  ) {

    insertInventoryStmt.run(
      id,

      Math.max(
        0,
        Math.floor(
          originalStock
        )
      )
    );
  }
}

/* =========================================================
   LIVE STOCK HELPERS
   ========================================================= */

function getLiveStock(
  productId
) {

  const row =
    getInventoryStmt.get(
      Number(
        productId
      )
    );

  if (
    !row
  ) {
    return null;
  }

  return Number(
    row.stock
  );
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
            : Number(
                product.stock ||
                0
              )
      };
    }
  );
}

/* =========================================================
   LIVE PRODUCT ROUTES
   ========================================================= */

app.get(
  "/products.json",

  (
    _req,
    res
  ) => {

    return res.json(
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

    return res.json(
      getLiveProducts()
    );
  }
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
   MEMORY
   ========================================================= */

const orders =
  new Map();

const discountCodes =
  new Map();

const referralEarnings =
  new Map();

let nextOrderId =
  1001;

/* =========================================================
   LOAD ORDERS
   ========================================================= */

for (
  const row
  of db
    .prepare(
      `
      SELECT id, json
      FROM orders
      `
    )
    .all()
) {

  try {

    orders.set(
      Number(
        row.id
      ),

      JSON.parse(
        row.json
      )
    );

  } catch (
    err
  ) {

    console.error(
      "ORDER LOAD ERROR:",
      row.id,
      err
    );
  }
}

/* =========================================================
   LOAD DISCOUNT CODES
   ========================================================= */

for (
  const row
  of db
    .prepare(
      `
      SELECT code, json
      FROM discount_codes
      `
    )
    .all()
) {

  try {

    discountCodes.set(
      String(
        row.code
      ).toUpperCase(),

      JSON.parse(
        row.json
      )
    );

  } catch (
    err
  ) {

    console.error(
      "DISCOUNT LOAD ERROR:",
      row.code,
      err
    );
  }
}

/* =========================================================
   LOAD AFFILIATE EARNINGS
   ========================================================= */

for (
  const row
  of db
    .prepare(
      `
      SELECT code, json
      FROM referral_earnings
      `
    )
    .all()
) {

  try {

    referralEarnings.set(
      String(
        row.code
      ).toUpperCase(),

      JSON.parse(
        row.json
      )
    );

  } catch (
    err
  ) {

    console.error(
      "AFFILIATE LOAD ERROR:",
      row.code,
      err
    );
  }
}

/* =========================================================
   NEXT ORDER ID
   ========================================================= */

const savedNextOrderId =
  db.prepare(
    `
    SELECT value
    FROM meta
    WHERE key = ?
    `
  )
    .get(
      "nextOrderId"
    );

if (
  savedNextOrderId
) {

  nextOrderId =
    Number(
      savedNextOrderId.value
    ) ||
    1001;
}

/* =========================================================
   BASIC HELPERS
   ========================================================= */

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

function saveNextOrderId(
  value
) {

  nextOrderId =
    value;

  upsertMetaStmt.run(
    "nextOrderId",
    String(
      value
    )
  );
}

function getMetaValue(
  key,
  fallback = null
) {

  const row =
    db.prepare(
      `
      SELECT value
      FROM meta
      WHERE key = ?
      `
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
    String(
      value
    )
  );
}

/* =========================================================
   ADMIN HELPERS
   ========================================================= */

function isAdmin(
  userId
) {

  if (
    userId ===
      undefined ||
    userId ===
      null
  ) {

    return false;
  }

  return configuredAdminIds.has(
    String(
      userId
    )
  );
}

function isOwner(
  userId
) {

  if (
    userId ===
      undefined ||
    userId ===
      null
  ) {

    return false;
  }

  if (
    ownerTelegramId
  ) {

    return (
      String(
        userId
      ) ===
      ownerTelegramId
    );
  }

  /*
    If OWNER_TELEGRAM_ID hasn't been set,
    fall back to the primary admin.
  */

  return (
    adminTelegramId &&
    String(
      userId
    ) ===
    String(
      adminTelegramId
    )
  );
}

/* =========================================================
   PROMO HELPERS
   ========================================================= */

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
      Number(
        getMetaValue(
          "storewidePromo:discountPercent",
          STOREWIDE_PROMO_DEFAULTS.discountPercent
        )
      ) ||
      STOREWIDE_PROMO_DEFAULTS.discountPercent,

    active:
      String(
        getMetaValue(
          "storewidePromo:active",
          STOREWIDE_PROMO_DEFAULTS.active
            ? "true"
            : "false"
        )
      ) ===
      "true",

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

  if (
    !promo.active
  ) {
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
    Number.isFinite(
      starts
    ) &&
    now <
      starts
  ) {
    return false;
  }

  if (
    Number.isFinite(
      ends
    ) &&
    now >
      ends
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

/* =========================================================
   SAVE DISCOUNT
   ========================================================= */

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

/* =========================================================
   SAVE AFFILIATE EARNINGS
   ========================================================= */

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

/* =========================================================
   DISCOUNT CALCULATION
   ========================================================= */

function calculateDiscount(
  subtotalPence,
  record
) {

  if (
    !record
  ) {
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

    Number(
      record.discountValue ||
      0
    )
  );
}

/* =========================================================
   CUSTOMER ORDER MATCH
   ========================================================= */

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
   SETUP AFFILIATE CODES
   ========================================================= */

for (
  const affiliate
  of affiliateCodes
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

  if (
    !referralEarnings.has(
      affiliate.code
    )
  ) {

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

    const existing =
      referralEarnings.get(
        affiliate.code
      );

    existing.owner =
      affiliate.owner;

    existing.cashOnly =
      true;

    existing.balancePence =
      Number(
        existing.balancePence ||
        0
      );

    existing.totalEarnedPence =
      Number(
        existing.totalEarnedPence ||
        0
      );

    existing.paidOutPence =
      Number(
        existing.paidOutPence ||
        0
      );

    saveReferralEarnings(
      affiliate.code,
      existing
    );
  }
}

/* =========================================================
   PROMO INITIAL VALUES
   ========================================================= */

if (
  getMetaValue(
    "storewidePromo:code"
  ) ===
  null
) {

  setMetaValue(
    "storewidePromo:code",
    STOREWIDE_PROMO_DEFAULTS.code
  );
}

if (
  getMetaValue(
    "storewidePromo:discountPercent"
  ) ===
  null
) {

  setMetaValue(
    "storewidePromo:discountPercent",
    STOREWIDE_PROMO_DEFAULTS.discountPercent
  );
}

if (
  getMetaValue(
    "storewidePromo:active"
  ) ===
  null
) {

  setMetaValue(
    "storewidePromo:active",
    STOREWIDE_PROMO_DEFAULTS.active
  );
}

if (
  getMetaValue(
    "storewidePromo:startsAt"
  ) ===
  null
) {

  setMetaValue(
    "storewidePromo:startsAt",
    STOREWIDE_PROMO_DEFAULTS.startsAt
  );
}

if (
  getMetaValue(
    "storewidePromo:endsAt"
  ) ===
  null
) {

  setMetaValue(
    "storewidePromo:endsAt",
    STOREWIDE_PROMO_DEFAULTS.endsAt
  );
}

/* =========================================================
   AFFILIATE EARNINGS TEXT
   ========================================================= */

function getAffiliateEarningsText() {

  let totalBalancePence =
    0;

  let totalEarnedPence =
    0;

  let totalPaidOutPence =
    0;

  const sections =
    affiliateCodes.map(
      affiliate => {

        const record =
          referralEarnings.get(
            affiliate.code
          );

        const balancePence =
          Number(
            record?.balancePence ||
            0
          );

        const earned =
          Number(
            record?.totalEarnedPence ||
            0
          );

        const paid =
          Number(
            record?.paidOutPence ||
            0
          );

        totalBalancePence +=
          balancePence;

        totalEarnedPence +=
          earned;

        totalPaidOutPence +=
          paid;

        return `👤 ${affiliate.owner}
Code: ${affiliate.code}

Currently owed:
${money(balancePence)}

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
${money(totalBalancePence)}

TOTAL AFFILIATE EARNINGS:
${money(totalEarnedPence)}

TOTAL PAID OUT:
${money(totalPaidOutPence)}`;
}

/* =========================================================
   CREDIT AFFILIATE AFTER PAYMENT
   ========================================================= */

function creditReferralForOrder(
  order
) {

  if (
    !order ||
    order.referralCredited ||
    !order.discountCode ||
    Number(
      order.referralCommissionPence ||
      0
    ) <=
      0
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
        false
    };

  record.owner =
    record.owner ||
    order.referralOwner ||
    null;

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
   RESERVE STOCK
   ========================================================= */

function reserveStockForOrder(
  order
) {

  if (
    order.stockReserved &&
    !order.stockReleased
  ) {

    return {
      ok:
        true,

      alreadyDone:
        true,

      expiresAt:
        order.stockReservationExpiresAt ||
        null
    };
  }

  db.exec(
    "BEGIN IMMEDIATE"
  );

  try {

    for (
      const item
      of order.items ||
      []
    ) {

      const productId =
        Number(
          item.id
        );

      const quantity =
        Number(
          item.quantity
        );

      const existing =
        getLiveStock(
          productId
        );

      /*
        Products without a live inventory
        record are ignored for compatibility.
      */

      if (
        existing ===
        null
      ) {
        continue;
      }

      const result =
        reserveInventoryStmt.run(
          quantity,
          productId,
          quantity
        );

      if (
        Number(
          result.changes ||
          0
        ) !==
        1
      ) {

        throw new Error(
          `Not enough stock remaining for ${item.name}. Available: ${getLiveStock(productId) ?? 0}.`
        );
      }
    }

    db.exec(
      "COMMIT"
    );

  } catch (
    err
  ) {

    try {

      db.exec(
        "ROLLBACK"
      );

    } catch {}

    return {
      ok:
        false,

      error:
        err?.message ||
        "Could not reserve stock."
    };
  }

  const now =
    Date.now();

  order.stockReserved =
    true;

  order.stockReleased =
    false;

  order.stockReservedAt =
    new Date(
      now
    ).toISOString();

  order.stockReservationExpiresAt =
    new Date(
      now +
      STOCK_RESERVATION_MS
    ).toISOString();

  saveOrder(
    order
  );

  return {
    ok:
      true,

    expiresAt:
      order.stockReservationExpiresAt
  };
}

/* =========================================================
   RETURN RESERVED STOCK
   ========================================================= */

function restoreReservedStock(
  order
) {

  if (
    !order ||
    !order.stockReserved ||
    order.stockReleased ||
    order.paymentStatus ===
      "paid"
  ) {

    return {
      ok:
        true,

      alreadyDone:
        true
    };
  }

  db.exec(
    "BEGIN IMMEDIATE"
  );

  try {

    for (
      const item
      of order.items ||
      []
    ) {

      const productId =
        Number(
          item.id
        );

      const quantity =
        Number(
          item.quantity
        );

      if (
        getLiveStock(
          productId
        ) ===
        null
      ) {
        continue;
      }

      restoreInventoryStmt.run(
        quantity,
        productId
      );
    }

    db.exec(
      "COMMIT"
    );

  } catch (
    err
  ) {

    try {

      db.exec(
        "ROLLBACK"
      );

    } catch {}

    throw err;
  }

  order.stockReleased =
    true;

  order.stockReleasedAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );

  return {
    ok:
      true
  };
}

/* =========================================================
   RETURN STORE CREDIT
   ========================================================= */

function restoreStoreCreditForOrder(
  order
) {

  if (
    !order ||
    order.storeCreditRestored ||
    !order.storeCreditCode ||
    Number(
      order.storeCreditPence ||
      0
    ) <=
      0
  ) {
    return;
  }

  const code =
    normaliseCode(
      order.storeCreditCode
    );

  const record =
    referralEarnings.get(
      code
    );

  if (
    !record ||
    record.cashOnly ===
      true
  ) {

    order.storeCreditRestored =
      true;

    saveOrder(
      order
    );

    return;
  }

  record.balancePence =
    Number(
      record.balancePence ||
      0
    ) +
    Number(
      order.storeCreditPence ||
      0
    );

  saveReferralEarnings(
    code,
    record
  );

  order.storeCreditRestored =
    true;

  order.storeCreditRestoredAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );
}

/* =========================================================
   RESERVATION EXPIRED?
   ========================================================= */

function reservationHasExpired(
  order
) {

  if (
    !order?.stockReservationExpiresAt
  ) {
    return false;
  }

  const expiry =
    new Date(
      order.stockReservationExpiresAt
    ).getTime();

  return (
    Number.isFinite(
      expiry
    ) &&
    Date.now() >=
      expiry
  );
}

/* =========================================================
   TELEGRAM
   ========================================================= */

let bot =
  null;

if (
  token
) {

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

  } catch (
    err
  ) {

    console.error(
      "TELEGRAM STARTUP ERROR:",
      err
    );
  }

} else {

  console.warn(
    "Telegram bot token missing."
  );
}

/* =========================================================
   SAFE TELEGRAM SEND
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

  } catch (
    err
  ) {

    console.error(
      "TELEGRAM SEND ERROR:",
      err?.response?.body ||
      err?.message ||
      err
    );

    return null;
  }
}

/* =========================================================
   SEND MESSAGE TO ALL ADMINS
   ========================================================= */

async function sendToAdmins(
  message,
  options
) {

  const ids =
    [
      ...configuredAdminIds
    ];

  if (
    !ids.length &&
    adminTelegramId
  ) {

    ids.push(
      adminTelegramId
    );
  }

  for (
    const id
    of ids
  ) {

    await safeSendMessage(
      id,
      message,
      options
    );
  }
}

/* =========================================================
   CANCEL UNPAID ORDER
   ========================================================= */

async function cancelUnpaidOrder(
  order,
  reason =
    "cancelled",
  notifyCustomer =
    true
) {

  if (
    !order
  ) {

    return {
      ok:
        false,

      error:
        "Order not found."
    };
  }

  if (
    order.paymentStatus ===
    "paid"
  ) {

    return {
      ok:
        false,

      error:
        "Paid orders cannot be cancelled using this action."
    };
  }

  if (
    order.paymentStatus ===
    "payment_submitted"
  ) {

    return {
      ok:
        false,

      error:
        "Payment has already been submitted. Check the transaction first."
    };
  }

  if (
    order.paymentStatus ===
      "cancelled" ||
    order.paymentStatus ===
      "expired"
  ) {

    return {
      ok:
        true,

      alreadyDone:
        true
    };
  }

  restoreReservedStock(
    order
  );

  restoreStoreCreditForOrder(
    order
  );

  order.paymentStatus =
    reason ===
      "expired"
      ? "expired"
      : "cancelled";

  order.fulfilmentStatus =
    "cancelled";

  order.cancelledAt =
    new Date()
      .toISOString();

  order.cancelReason =
    reason;

  saveOrder(
    order
  );

  if (
    notifyCustomer &&
    order.telegramId
  ) {

    if (
      reason ===
      "expired"
    ) {

      await safeSendMessage(
        order.telegramId,

`⌛ Order #${order.orderId} expired.

Payment was not submitted within ${STOCK_RESERVATION_MINUTES} minutes.

The reserved stock has now been returned to the shop.`
      );

    } else {

      await safeSendMessage(
        order.telegramId,

`❌ Order #${order.orderId} has been cancelled.

The reserved stock has now been returned to the shop.`
      );
    }
  }

  return {
    ok:
      true
  };
}

/* =========================================================
   EXPIRE OLD RESERVATIONS
   ========================================================= */

async function expireOldReservations() {

  for (
    const order
    of orders.values()
  ) {

    if (
      order.paymentStatus !==
        "awaiting_payment" ||
      !order.stockReserved ||
      order.stockReleased ||
      !reservationHasExpired(
        order
      )
    ) {

      continue;
    }

    try {

      await cancelUnpaidOrder(
        order,
        "expired",
        true
      );

      await sendToAdmins(
`⌛ ORDER EXPIRED

Order:
#${order.orderId}

Customer:
${order.customerName}

No payment was submitted within ${STOCK_RESERVATION_MINUTES} minutes.

Reserved stock has been returned to circulation.`
      );

    } catch (
      err
    ) {

      console.error(
        "ORDER EXPIRY ERROR:",
        order.orderId,
        err
      );
    }
  }
}

/* =========================================================
   LEGACY STOCK DEDUCTION
   ========================================================= */

function deductStockForOrder(
  order
) {

  /*
    New reservation-system orders have
    already had their stock removed.
  */

  if (
    order.stockReserved &&
    !order.stockReleased
  ) {

    order.stockDeducted =
      true;

    order.stockDeductedAt =
      order.stockDeductedAt ||
      order.stockReservedAt ||
      new Date()
        .toISOString();

    saveOrder(
      order
    );

    return {
      ok:
        true,

      alreadyReserved:
        true
    };
  }

  /*
    Old orders created before the reservation
    system are still supported.
  */

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

  db.exec(
    "BEGIN IMMEDIATE"
  );

  try {

    for (
      const item
      of order.items ||
      []
    ) {

      const productId =
        Number(
          item.id
        );

      const quantity =
        Number(
          item.quantity
        );

      if (
        getLiveStock(
          productId
        ) ===
        null
      ) {

        continue;
      }

      const result =
        reserveInventoryStmt.run(
          quantity,
          productId,
          quantity
        );

      if (
        Number(
          result.changes ||
          0
        ) !==
        1
      ) {

        throw new Error(
          `Not enough stock remaining for ${item.name}. Available: ${getLiveStock(productId) ?? 0}.`
        );
      }
    }

    db.exec(
      "COMMIT"
    );

  } catch (
    err
  ) {

    try {

      db.exec(
        "ROLLBACK"
      );

    } catch {}

    return {
      ok:
        false,

      error:
        err?.message ||
        "Could not deduct stock."
    };
  }

  order.stockDeducted =
    true;

  order.stockDeductedAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );

  return {
    ok:
      true
  };
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

      throw new Error(
        "Invalid USDT rate."
      );
    }

    const pounds =
      Number(
        totalPence
      ) /
      100;

    return (
      pounds /
      gbpPerUsdt
    ).toFixed(
      2
    );

  } catch (
    err
  ) {

    console.error(
      "USDT QUOTE ERROR:",
      err?.message ||
      err
    );

    return null;
  }
}

/* =========================================================
   REVIEW URL
   ========================================================= */

function getReviewUrl(
  order
) {

  if (
    !webAppUrl ||
    !order.reviewToken
  ) {
    return null;
  }

  const base =
    webAppUrl.replace(
      /\/+$/,
      ""
    );

  return (
    `${base}/review/${order.orderId}` +
    `?token=${encodeURIComponent(
      order.reviewToken
    )}`
  );
}

/* =========================================================
   MARK ORDER PAID
   ========================================================= */

async function markOrderPaid(
  order
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
      "cancelled" ||
    order.paymentStatus ===
      "expired"
  ) {

    return {
      ok:
        false,

      error:
        "This order has already been cancelled or expired."
    };
  }

  const stockResult =
    deductStockForOrder(
      order
    );

  if (
    !stockResult.ok
  ) {

    return stockResult;
  }

  order.paymentStatus =
    "paid";

  order.paidAt =
    new Date()
      .toISOString();

  saveOrder(
    order
  );

  if (
    Number(
      order.referralCommissionPence ||
      0
    ) >
      0 &&
    !order.referralCredited
  ) {

    creditReferralForOrder(
      order
    );
  }

  const itemLines =
    (
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

  await sendToAdmins(
`✅ PAYMENT CONFIRMED

Order:
#${order.orderId}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(order.telegramUsername)}`
    : "Not supplied"
}

📍 DELIVERY ADDRESS:
${order.address}

ITEMS:
${itemLines || "No items"}

Basket:
${money(order.subtotalPence)}

Affiliate saving:
-${money(order.affiliateDiscountPence || order.discountPence)}

Store promo saving:
-${money(order.storewideDiscountPence)}

Store credit:
-${money(order.storeCreditPence)}

Shipping:
${money(order.shippingPence)}

TOTAL:
${money(order.totalPence)}

Transaction:
${order.transactionId || "Marked paid manually"}

Stock:
✅ Reserved stock confirmed as sold`
  );

  if (
    order.telegramId
  ) {

    const reviewUrl =
      getReviewUrl(
        order
      );

    const options =
      reviewUrl
        ? {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Leave a Review",

                    url:
                      reviewUrl
                  }
                ]
              ]
            }
          }
        : undefined;

    await safeSendMessage(
      order.telegramId,

`✅ Payment confirmed

Order:
#${order.orderId}

Total:
${money(order.totalPence)}

Your order is now being processed.

Thank you for your order. ⚡️`,

      options
    );
  }

  return {
    ok:
      true
  };
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",

  (
    _req,
    res
  ) => {

    return res.json({
      ok:
        true,

      products:
        products.length,

      admins:
        configuredAdminIds.size,

      minimumOrderPence:
        MINIMUM_ORDER_PENCE,

      shippingPence:
        SHIPPING_PENCE,

      reservationMinutes:
        STOCK_RESERVATION_MINUTES,

      telegramConfigured:
        Boolean(
          token
        ),

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
        .status(
          400
        )
        .json({
          error:
            "Invalid cart event."
        });
    }

    insertCartEventStmt.run(
      productId,
      action,
      new Date()
        .toISOString()
    );

    return res.json({
      ok:
        true
    });
  }
);

/* =========================================================
   DISCOUNT CODE LOOKUP
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
        .status(
          404
        )
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

/* =========================================================
   STORE PROMO LOOKUP
   ========================================================= */

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
        .status(
          404
        )
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

      startsAt:
        promo.startsAt,

      endsAt:
        promo.endsAt,

      stackWithAffiliate:
        true
    });
  }
);

/* =========================================================
   REFERRAL EARNINGS LOOKUP
   ========================================================= */

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

    if (
      !record
    ) {

      return res
        .status(
          404
        )
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

  async (
    req,
    res
  ) => {

    let order =
      null;

    let storeCreditWasTaken =
      false;

    try {

      const {
        customerName,
        telegramUsername,
        telegramId,
        address,
        items,
        discountCode,
        storewideCode,
        storeCreditCode
      } =
        req.body ||
        {};

      if (
        !customerName ||
        !address ||
        !Array.isArray(
          items
        ) ||
        items.length ===
          0
      ) {

        return res
          .status(
            400
          )
          .json({
            error:
              "Missing order details."
          });
      }

      const lineItems =
        [];

      let subtotalPence =
        0;

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
          quantity <=
            0
        ) {

          return res
            .status(
              400
            )
            .json({
              error:
                "Invalid item in basket."
            });
        }

        if (
          product.purchasable ===
          false
        ) {

          return res
            .status(
              400
            )
            .json({
              error:
                `${product.name} is not currently available to order.`
            });
        }

        const liveStock =
          getLiveStock(
            id
          );

        if (
          liveStock !==
            null &&
          quantity >
            liveStock
        ) {

          return res
            .status(
              409
            )
            .json({
              error:
                `Not enough stock for ${product.name}. Available: ${liveStock}.`
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
          pricePence <
            0
        ) {

          return res
            .status(
              400
            )
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

      if (
        subtotalPence <
        MINIMUM_ORDER_PENCE
      ) {

        return res
          .status(
            400
          )
          .json({
            error:
              "Minimum basket is £50 before discounts and shipping."
          });
      }

      /* ===================================================
         AFFILIATE DISCOUNT
         =================================================== */

      let affiliateDiscountPence =
        0;

      let appliedDiscountCode =
        null;

      let referralOwner =
        null;

      let referralCommissionPence =
        0;

      if (
        discountCode
      ) {

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
          record.active !==
            false
        ) {

          affiliateDiscountPence =
            calculateDiscount(
              subtotalPence,
              record
            );

          appliedDiscountCode =
            code;

          if (
            record.referralOwner &&
            Number(
              record.commissionPercent ||
              0
            ) >
              0
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

      /* ===================================================
         STORE PROMO
         =================================================== */

      let storewideDiscountPence =
        0;

      let appliedStorewideCode =
        null;

      if (
        storewideCode
      ) {

        const promo =
          getStorewidePromo();

        const submittedPromo =
          normaliseCode(
            storewideCode
          );

        if (
          submittedPromo ===
            promo.code &&
          isStorewidePromoLive(
            promo
          )
        ) {

          /*
            Both discounts calculate from the
            ORIGINAL subtotal.

            Therefore:
            10% affiliate + 10% promo = 20%.
          */

          storewideDiscountPence =
            storewideDiscountForSubtotal(
              subtotalPence,
              promo
            );

          appliedStorewideCode =
            promo.code;
        }
      }

      const totalSavingsPence =
        Math.min(
          subtotalPence,

          affiliateDiscountPence +
          storewideDiscountPence
        );

      /* ===================================================
         STORE CREDIT
         =================================================== */

      let storeCreditPence =
        0;

      let appliedCreditCode =
        null;

      if (
        storeCreditCode
      ) {

        const creditCode =
          normaliseCode(
            storeCreditCode
          );

        const credit =
          referralEarnings.get(
            creditCode
          );

        if (
          credit &&
          credit.cashOnly !==
            true
        ) {

          const remaining =
            Math.max(
              0,

              subtotalPence -
              totalSavingsPence
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
              creditCode;

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
              creditCode,
              credit
            );

            storeCreditWasTaken =
              true;
          }
        }
      }

      const productsAfterDiscount =
        Math.max(
          0,

          subtotalPence -
          totalSavingsPence -
          storeCreditPence
        );

      const shippingPence =
        SHIPPING_PENCE;

      const totalPence =
        productsAfterDiscount +
        shippingPence;

      const usdtQuote =
        await getUsdtQuote(
          totalPence
        );

      const orderId =
        nextOrderId;

      saveNextOrderId(
        nextOrderId +
        1
      );

      order = {
        orderId,

        customerName:
          String(
            customerName
          )
            .trim()
            .slice(
              0,
              100
            ),

        telegramUsername:
          String(
            telegramUsername ||
            ""
          )
            .trim()
            .slice(
              0,
              100
            ),

        telegramId:
          telegramId ||
          null,

        address:
          String(
            address
          )
            .trim()
            .slice(
              0,
              1000
            ),

        items:
          lineItems,

        subtotalPence,

        discountPence:
          affiliateDiscountPence,

        affiliateDiscountPence,

        storewideDiscountPence,

        totalSavingsPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        discountCode:
          appliedDiscountCode,

        storewideCode:
          appliedStorewideCode,

        storeCreditCode:
          appliedCreditCode,

        storeCreditRestored:
          false,

        referralOwner,

        referralCommissionPence,

        referralCredited:
          false,

        stockDeducted:
          false,

        stockReserved:
          false,

        stockReleased:
          false,

        stockReservationExpiresAt:
          null,

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

        adminNotes:
          [],

        reviewToken:
          randomUUID(),

        createdAt:
          new Date()
            .toISOString()
      };

      saveOrder(
        order
      );

      /*
        IMPORTANT:

        This is the moment stock actually
        becomes unavailable to other shoppers.
      */

      const reservation =
        reserveStockForOrder(
          order
        );

      if (
        !reservation.ok
      ) {

        if (
          storeCreditWasTaken
        ) {

          restoreStoreCreditForOrder(
            order
          );
        }

        order.paymentStatus =
          "cancelled";

        order.fulfilmentStatus =
          "cancelled";

        order.cancelReason =
          "stock_unavailable";

        order.cancelledAt =
          new Date()
            .toISOString();

        saveOrder(
          order
        );

        return res
          .status(
            409
          )
          .json({
            error:
              reservation.error ||
              "Stock changed before the order could be reserved. Refresh and try again."
          });
      }

      const itemLines =
        lineItems
          .map(
            item =>
              `• ${item.name} × ${item.quantity} — ${money(item.lineTotalPence)}`
          )
          .join(
            "\n"
          );

      await sendToAdmins(
`🧾 NEW ORDER

Order:
#${orderId}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(order.telegramUsername)}`
    : "Not supplied"
}

📍 DELIVERY ADDRESS:
${order.address}

ITEMS:
${itemLines}

Basket:
${money(subtotalPence)}

Affiliate saving:
-${money(affiliateDiscountPence)}

Store promo saving:
-${money(storewideDiscountPence)}

TOTAL SAVINGS:
-${money(totalSavingsPence)}

Store credit:
-${money(storeCreditPence)}

Shipping:
${money(shippingPence)}

TOTAL:
${money(totalPence)}

Affiliate code:
${appliedDiscountCode || "None"}

Store promo:
${appliedStorewideCode || "None"}

${
  referralCommissionPence
    ? `Referral owner:
${referralOwner}

Commission once paid:
${money(referralCommissionPence)}`
    : ""
}

Status:
Awaiting payment

⏳ Stock reserved:
${STOCK_RESERVATION_MINUTES} minutes

Reservation expiry:
${order.stockReservationExpiresAt}`
      );

      return res.json({
        ok:
          true,

        orderId,

        subtotalPence,

        discountPence:
          affiliateDiscountPence,

        affiliateDiscountPence,

        storewideDiscountPence,

        totalSavingsPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        status:
          order.paymentStatus,

        reservationMinutes:
          STOCK_RESERVATION_MINUTES,

        stockReservationExpiresAt:
          order.stockReservationExpiresAt,

        payment: {
          method:
            "crypto",

          network:
            "ERC-20",

          address:
            receivingAddress,

          quote: {
            USDT:
              usdtQuote ||
              "QUOTE_PENDING"
          },

          instructions:
            receivingAddress
              ? (
                  usdtQuote
                    ? `Send ${usdtQuote} USDT using Ethereum ERC-20 only, then submit the transaction hash.`
                    : "Payment quote is temporarily unavailable."
                )
              : "Payment address is not configured."
        }
      });

    } catch (
      err
    ) {

      console.error(
        "CREATE ORDER ERROR:",
        err
      );

      /*
        If an order had been saved and its
        reserved stock was taken but something
        subsequently failed, return the stock.
      */

      if (
        order &&
        order.paymentStatus ===
          "awaiting_payment"
      ) {

        try {

          restoreReservedStock(
            order
          );

          restoreStoreCreditForOrder(
            order
          );

          order.paymentStatus =
            "cancelled";

          order.fulfilmentStatus =
            "cancelled";

          order.cancelReason =
            "create_order_error";

          saveOrder(
            order
          );

        } catch (
          rollbackError
        ) {

          console.error(
            "CREATE ORDER ROLLBACK ERROR:",
            rollbackError
          );
        }
      }

      return res
        .status(
          500
        )
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

    if (
      !order
    ) {

      return res
        .status(
          404
        )
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

      subtotalPence:
        order.subtotalPence,

      discountPence:
        order.discountPence,

      affiliateDiscountPence:
        order.affiliateDiscountPence ||
        order.discountPence ||
        0,

      storewideDiscountPence:
        order.storewideDiscountPence ||
        0,

      totalSavingsPence:
        order.totalSavingsPence ||
        0,

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
        null,

      stockReservationExpiresAt:
        order.stockReservationExpiresAt ||
        null
    });
  }
);

/* =========================================================
   SUBMIT TRANSACTION HASH
   ========================================================= */

app.post(
  "/api/orders/:id/confirm-payment",

  async (
    req,
    res
  ) => {

    const order =
      orders.get(
        Number(
          req.params.id
        )
      );

    if (
      !order
    ) {

      return res
        .status(
          404
        )
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

        alreadyPaid:
          true
      });
    }

    if (
      order.paymentStatus ===
        "cancelled" ||
      order.paymentStatus ===
        "expired"
    ) {

      return res
        .status(
          410
        )
        .json({
          error:
            "This order has been cancelled or expired."
        });
    }

    /*
      If they reach this route after the
      30-minute deadline, expire it immediately.
    */

    if (
      order.paymentStatus ===
        "awaiting_payment" &&
      order.stockReserved &&
      !order.stockReleased &&
      reservationHasExpired(
        order
      )
    ) {

      await cancelUnpaidOrder(
        order,
        "expired",
        true
      );

      return res
        .status(
          410
        )
        .json({
          error:
            `This order expired after ${STOCK_RESERVATION_MINUTES} minutes. The stock has been returned to the shop.`
        });
    }

    const transactionId =
      String(
        req.body?.transactionId ||
        ""
      ).trim();

    if (
      !/^0x[a-fA-F0-9]{64}$/.test(
        transactionId
      )
    ) {

      return res
        .status(
          400
        )
        .json({
          error:
            "Enter a valid Ethereum transaction hash."
        });
    }

    const alreadyUsed =
      [
        ...orders.values()
      ]
        .some(
          existing =>

            existing.orderId !==
              order.orderId &&

            existing.transactionId
              ?.toLowerCase() ===
              transactionId
                .toLowerCase()
        );

    if (
      alreadyUsed
    ) {

      return res
        .status(
          400
        )
        .json({
          error:
            "That transaction has already been used."
        });
    }

    order.transactionId =
      transactionId;

    /*
      This is important:
      once a hash has been submitted,
      the reservation no longer auto-expires
      while you verify it.
    */

    order.paymentStatus =
      "payment_submitted";

    order.paymentSubmittedAt =
      new Date()
        .toISOString();

    saveOrder(
      order
    );

    const itemLines =
      (
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

    await sendToAdmins(
`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

ITEMS:
${itemLines || "No items"}

📍 DELIVERY ADDRESS:
${order.address}

Expected total:
${money(order.totalPence)}

Transaction:
${transactionId}

Stock remains reserved while payment is checked.

Use:
/paid ${order.orderId}

once the transaction has been verified.`
    );

    return res.json({
      ok:
        true,

      orderId:
        order.orderId,

      status:
        "payment_submitted",

      message:
        "Payment submitted. We'll confirm it shortly."
    });
  }
);

/* =========================================================
   REVIEWS
   ========================================================= */

app.get(
  "/api/reviews",

  (
    _req,
    res
  ) => {

    const reviews =
      db.prepare(`
        SELECT
          id,
          order_id,
          display_name,
          rating,
          review_text,
          created_at
        FROM reviews
        WHERE approved = 1
        ORDER BY id DESC
        LIMIT 100
      `)
        .all();

    return res.json(
      reviews
    );
  }
);

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

    const token =
      String(
        req.body?.token ||
        ""
      );

    const displayName =
      String(
        req.body?.displayName ||
        "Customer"
      )
        .trim()
        .slice(
          0,
          50
        );

    const rating =
      Number(
        req.body?.rating
      );

    const reviewText =
      String(
        req.body?.reviewText ||
        ""
      )
        .trim()
        .slice(
          0,
          1000
        );

    const order =
      orders.get(
        orderId
      );

    if (
      !order
    ) {

      return res
        .status(
          404
        )
        .json({
          error:
            "Order not found."
        });
    }

    if (
      order.paymentStatus !==
      "paid"
    ) {

      return res
        .status(
          403
        )
        .json({
          error:
            "Reviews can be submitted after payment is confirmed."
        });
    }

    if (
      !token ||
      token !==
        order.reviewToken
    ) {

      return res
        .status(
          403
        )
        .json({
          error:
            "Invalid review link."
        });
    }

    if (
      !Number.isInteger(
        rating
      ) ||
      rating <
        1 ||
      rating >
        5
    ) {

      return res
        .status(
          400
        )
        .json({
          error:
            "Rating must be between 1 and 5."
        });
    }

    if (
      !reviewText
    ) {

      return res
        .status(
          400
        )
        .json({
          error:
            "Please enter a review."
        });
    }

    db.prepare(`
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

      ON CONFLICT(order_id)
      DO UPDATE SET
        display_name = excluded.display_name,
        rating = excluded.rating,
        review_text = excluded.review_text,
        approved = 0,
        created_at = excluded.created_at
    `)
      .run(
        orderId,

        String(
          order.telegramId ||
          ""
        ),

        displayName,

        rating,

        reviewText,

        new Date()
          .toISOString()
      );

    const review =
      db.prepare(
        `
        SELECT *
        FROM reviews
        WHERE order_id = ?
        `
      )
        .get(
          orderId
        );

    if (
      review
    ) {

      sendToAdmins(
`⭐ NEW REVIEW

Review:
#${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

Rating:
${review.rating}/5

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

    return res.json({
      ok:
        true,

      message:
        "Thank you. Your review has been submitted."
    });
  }
);

/* =========================================================
   REVIEW PAGE
   ========================================================= */

app.get(
  "/review/:orderId",

  (
    req,
    res
  ) => {

    const orderId =
      Number(
        req.params.orderId
      );

    const reviewToken =
      String(
        req.query.token ||
        ""
      );

    const order =
      orders.get(
        orderId
      );

    if (
      !order ||
      reviewToken !==
        order.reviewToken
    ) {

      return res
        .status(
          404
        )
        .send(
          "Review link not found."
        );
    }

    if (
      order.paymentStatus !==
      "paid"
    ) {

      return res
        .status(
          403
        )
        .send(
          "Payment must be confirmed before leaving a review."
        );
    }

    const safeToken =
      JSON.stringify(
        reviewToken
      );

    res.type(
      "html"
    );

    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>
<title>Leave a Review</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 24px;
  font-family: Arial, sans-serif;
  background: #ffffff;
  color: #111111;
}

.card {
  max-width: 520px;
  margin: 30px auto;
  border: 1px solid #d5b04c;
  border-radius: 18px;
  padding: 24px;
}

h1 {
  margin-top: 0;
}

.gold {
  color: #b58b16;
}

label {
  display: block;
  font-weight: 700;
  margin-top: 18px;
  margin-bottom: 8px;
}

input,
select,
textarea {
  width: 100%;
  font-size: 16px;
  padding: 13px;
  border: 1px solid #cccccc;
  border-radius: 10px;
}

textarea {
  min-height: 130px;
  resize: vertical;
}

button {
  width: 100%;
  margin-top: 22px;
  padding: 15px;
  border: 0;
  border-radius: 12px;
  background: #c9a227;
  color: #ffffff;
  font-size: 17px;
  font-weight: 700;
}

#message {
  margin-top: 18px;
  font-weight: 700;
}
</style>
</head>

<body>

<div class="card">

<h1>
<span class="gold">★</span>
Leave a Review
</h1>

<p>
Order #${orderId}
</p>

<label>Name</label>

<input
  id="name"
  maxlength="50"
  placeholder="Your name"
>

<label>Rating</label>

<select id="rating">
<option value="5">★★★★★ - 5</option>
<option value="4">★★★★☆ - 4</option>
<option value="3">★★★☆☆ - 3</option>
<option value="2">★★☆☆☆ - 2</option>
<option value="1">★☆☆☆☆ - 1</option>
</select>

<label>Review</label>

<textarea
  id="review"
  maxlength="1000"
  placeholder="Tell us about your experience..."
></textarea>

<button id="submit">
Submit Review
</button>

<div id="message"></div>

</div>

<script>

const orderId =
  ${orderId};

const token =
  ${safeToken};

document
  .getElementById("submit")
  .addEventListener(
    "click",

    async () => {

      const button =
        document.getElementById(
          "submit"
        );

      const message =
        document.getElementById(
          "message"
        );

      button.disabled =
        true;

      message.textContent =
        "Submitting...";

      try {

        const response =
          await fetch(
            "/api/reviews",

            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  orderId,

                  token,

                  displayName:
                    document
                      .getElementById("name")
                      .value,

                  rating:
                    Number(
                      document
                        .getElementById("rating")
                        .value
                    ),

                  reviewText:
                    document
                      .getElementById("review")
                      .value
                })
            }
          );

        const data =
          await response.json();

        if (
          !response.ok
        ) {

          throw new Error(
            data.error ||
            "Could not submit review."
          );
        }

        message.textContent =
          "⭐ Thank you. Your review has been submitted.";

      } catch (
        err
      ) {

        message.textContent =
          err.message;

        button.disabled =
          false;
      }
    }
  );

</script>

</body>
</html>
    `);
  }
);

/* =========================================================
   TELEGRAM ADMIN STATE
   ========================================================= */

const pendingSupport =
  new Set();

const pendingAdminOrderLookup =
  new Set();

const pendingAdminTracking =
  new Map();

const pendingAdminNote =
  new Map();

const pendingStockAdjustment =
  new Map();

/* =========================================================
   TELEGRAM BOT
   ========================================================= */

if (
  bot
) {

  /* =======================================================
     REGISTER BOT COMMANDS
     ======================================================= */

  bot.setMyCommands([
    {
      command:
        "start",

      description:
        "Open the shop menu"
    },
    {
      command:
        "admin",

      description:
        "Open admin dashboard"
    },
    {
      command:
        "summary",

      description:
        "7 day shop summary"
    },
    {
      command:
        "earnings",

      description:
        "Affiliate earnings"
    },
    {
      command:
        "reviews",

      description:
        "Reviews awaiting approval"
    },
    {
      command:
        "paid",

      description:
        "Mark order paid: /paid 1001"
    },
    {
      command:
        "tracking",

      description:
        "Add tracking: /tracking 1001 TRACKING"
    },
    {
      command:
        "setstock",

      description:
        "Set stock: /setstock 123 10"
    },
    {
      command:
        "myid",

      description:
        "Show your Telegram ID"
    }
  ])
    .catch(
      err =>
        console.error(
          "SET COMMANDS ERROR:",
          err
        )
    );

  /* =======================================================
     CLEAR INPUTS
     ======================================================= */

  function clearAdminInputs(
    chatId
  ) {

    pendingAdminOrderLookup.delete(
      chatId
    );

    pendingAdminTracking.delete(
      chatId
    );

    pendingAdminNote.delete(
      chatId
    );

    pendingStockAdjustment.delete(
      chatId
    );
  }

  /* =======================================================
     STATUS TEXT
     ======================================================= */

  function getOrderStatusText(
    order
  ) {

    if (
      order.paymentStatus ===
      "expired"
    ) {

      return "Expired ⌛";
    }

    if (
      order.paymentStatus ===
        "cancelled" ||
      order.fulfilmentStatus ===
        "cancelled"
    ) {

      return "Cancelled ❌";
    }

    if (
      order.fulfilmentStatus ===
      "shipped"
    ) {

      return "Shipped 📦";
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

  /* =======================================================
     RECENT ORDERS
     ======================================================= */

  function getRecentOrders(
    limit =
      10
  ) {

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
      )
      .slice(
        0,
        limit
      );
  }

  /* =======================================================
     LONG TELEGRAM MESSAGE
     ======================================================= */

  async function sendLongMessage(
    chatId,
    message
  ) {

    const maxLength =
      3500;

    if (
      message.length <=
      maxLength
    ) {

      return safeSendMessage(
        chatId,
        message
      );
    }

    const paragraphs =
      message.split(
        "\n\n"
      );

    let chunk =
      "";

    for (
      const paragraph
      of paragraphs
    ) {

      const next =
        chunk
          ? `${chunk}\n\n${paragraph}`
          : paragraph;

      if (
        next.length >
        maxLength
      ) {

        if (
          chunk
        ) {

          await safeSendMessage(
            chatId,
            chunk
          );
        }

        chunk =
          paragraph;

      } else {

        chunk =
          next;
      }
    }

    if (
      chunk
    ) {

      await safeSendMessage(
        chatId,
        chunk
      );
    }
  }

  /* =======================================================
     ADMIN DASHBOARD BUTTONS
     ======================================================= */

  function getAdminDashboardOptions() {

    return {

      reply_markup: {

        inline_keyboard: [

          [
            {
              text:
                "📦 Recent Orders",

              callback_data:
                "admin_recent_orders"
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
                "🚚 Dispatch Queue",

              callback_data:
                "admin_dispatch"
            },

            {
              text:
                "🔎 Find Order",

              callback_data:
                "admin_find_order"
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
                "💰 Affiliate Earnings",

              callback_data:
                "admin_earnings"
            }
          ],

          [
            {
              text:
                "🎉 Storewide Promo",

              callback_data:
                "admin_storewide_promo"
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

  /* =======================================================
     ADMIN DASHBOARD
     ======================================================= */

  async function sendAdminDashboard(
    chatId
  ) {

    clearAdminInputs(
      chatId
    );

    const allOrders =
      [
        ...orders.values()
      ];

    const paymentWaiting =
      allOrders.filter(
        order =>
          order.paymentStatus ===
          "payment_submitted"
      ).length;

    const awaitingPayment =
      allOrders.filter(
        order =>
          order.paymentStatus ===
          "awaiting_payment"
      ).length;

    const dispatchWaiting =
      allOrders.filter(
        order =>
          order.paymentStatus ===
            "paid" &&
          order.fulfilmentStatus !==
            "shipped"
      ).length;

    const completed =
      allOrders.filter(
        order =>
          order.fulfilmentStatus ===
          "completed"
      ).length;

    const cancelled =
      allOrders.filter(
        order =>
          order.paymentStatus ===
            "cancelled" ||
          order.paymentStatus ===
            "expired"
      ).length;

    const pendingReviews =
      Number(
        db.prepare(`
          SELECT COUNT(*) AS count
          FROM reviews
          WHERE approved = 0
        `)
          .get()
          ?.count ||
        0
      );

    const liveProducts =
      getLiveProducts();

    const lowStock =
      liveProducts.filter(
        product => {

          const stock =
            Number(
              product.stock
            );

          return (
            Number.isFinite(
              stock
            ) &&
            stock >
              0 &&
            stock <=
              LOW_STOCK_THRESHOLD
          );
        }
      ).length;

    const outStock =
      liveProducts.filter(
        product =>
          Number(
            product.stock
          ) ===
          0
      ).length;

    return safeSendMessage(
      chatId,

`🛠 ADMIN DASHBOARD

📦 Total orders:
${allOrders.length}

⏳ Awaiting payment:
${awaitingPayment}

💳 Payments to check:
${paymentWaiting}

🚚 Ready to dispatch:
${dispatchWaiting}

✅ Completed:
${completed}

❌ Cancelled / expired:
${cancelled}

⭐ Reviews waiting:
${pendingReviews}

📉 Low stock:
${lowStock}

❌ Out of stock:
${outStock}

👥 Affiliates:
${affiliateCodes.length}

👮 Admins:
${configuredAdminIds.size}

Choose an option below.`,

      getAdminDashboardOptions()
    );
  }

  /* =======================================================
     ADMIN ORDER BUTTONS
     ======================================================= */

  function getAdminOrderButtons(
    order
  ) {

    const buttons =
      [];

    const cancelled =
      order.paymentStatus ===
        "cancelled" ||
      order.paymentStatus ===
        "expired";

    if (
      !cancelled &&
      order.paymentStatus !==
        "paid"
    ) {

      buttons.push([
        {
          text:
            "✅ Mark Paid",

          callback_data:
            `admin_paid_${order.orderId}`
        }
      ]);
    }

    if (
      order.paymentStatus ===
        "paid" &&
      order.fulfilmentStatus !==
        "shipped" &&
      order.fulfilmentStatus !==
        "completed"
    ) {

      buttons.push([
        {
          text:
            "🚚 Add Tracking",

          callback_data:
            `admin_tracking_${order.orderId}`
        }
      ]);
    }

    if (
      order.paymentStatus ===
        "awaiting_payment"
    ) {

      buttons.push([
        {
          text:
            "❌ Cancel Order",

          callback_data:
            `admin_cancel_${order.orderId}`
        }
      ]);
    }

    buttons.push([
      {
        text:
          "📝 Add Note",

        callback_data:
          `admin_note_${order.orderId}`
      }
    ]);

    if (
      order.paymentStatus ===
      "paid"
    ) {

      buttons.push([
        {
          text:
            "⭐ Send Review Link",

          callback_data:
            `admin_review_${order.orderId}`
        }
      ]);
    }

    buttons.push([
      {
        text:
          "⬅️ Admin Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);

    return {
      reply_markup: {
        inline_keyboard:
          buttons
      }
    };
  }

  /* =======================================================
     SHOW ADMIN ORDER
     ======================================================= */

  async function showAdminOrder(
    chatId,
    order
  ) {

    const items =
      (
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
        ) ||
      "No items";

    const notes =
      Array.isArray(
        order.adminNotes
      ) &&
      order.adminNotes.length

        ? order.adminNotes
            .map(
              note =>
                `• ${note.text}`
            )
            .join(
              "\n"
            )

        : "None";

    let reservation =
      "None";

    if (
      order.stockReserved &&
      !order.stockReleased
    ) {

      if (
        order.paymentStatus ===
        "payment_submitted"
      ) {

        reservation =
          "Reserved — payment submitted";

      } else if (
        order.paymentStatus ===
        "paid"
      ) {

        reservation =
          "Confirmed sold";

      } else {

        reservation =
          `Reserved until ${order.stockReservationExpiresAt || "Unknown"}`;
      }
    }

    if (
      order.stockReleased
    ) {

      reservation =
        "Returned to available stock";
    }

    return safeSendMessage(
      chatId,

`📦 ORDER #${order.orderId}

Status:
${getOrderStatusText(order)}

Stock:
${reservation}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(order.telegramUsername)}`
    : "Not supplied"
}

📍 DELIVERY ADDRESS:
${order.address}

ITEMS:
${items}

Basket:
${money(order.subtotalPence)}

Affiliate saving:
-${money(order.affiliateDiscountPence || order.discountPence)}

Store promo saving:
-${money(order.storewideDiscountPence)}

Store credit:
-${money(order.storeCreditPence)}

Shipping:
${money(order.shippingPence)}

TOTAL:
${money(order.totalPence)}

Transaction:
${order.transactionId || "None"}

Tracking:
${order.trackingNumber || "None"}

Admin notes:
${notes}`,

      getAdminOrderButtons(
        order
      )
    );
  }

  /* =======================================================
     SHOW ORDER LIST
     ======================================================= */

  async function showOrderList(
    chatId,
    title,
    list
  ) {

    if (
      !list.length
    ) {

      return safeSendMessage(
        chatId,

`${title}

Nothing here.`,

        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "⬅️ Admin Dashboard",

                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }

    const buttons =
      list
        .slice(
          0,
          20
        )
        .map(
          order => [
            {
              text:
                `#${order.orderId} • ${order.customerName} • ${money(order.totalPence)}`,

              callback_data:
                `admin_order_${order.orderId}`
            }
          ]
        );

    buttons.push([
      {
        text:
          "⬅️ Admin Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);

    return safeSendMessage(
      chatId,

`${title}

Tap an order to manage it.`,

      {
        reply_markup: {
          inline_keyboard:
            buttons
        }
      }
    );
  }

  /* =======================================================
     STOCK CENTRE
     ======================================================= */

  async function showStockCentre(
    chatId
  ) {

    const live =
      getLiveProducts();

    const low =
      live.filter(
        product => {

          const stock =
            Number(
              product.stock
            );

          return (
            Number.isFinite(
              stock
            ) &&
            stock >
              0 &&
            stock <=
              LOW_STOCK_THRESHOLD
          );
        }
      );

    const out =
      live.filter(
        product =>
          Number(
            product.stock
          ) ===
          0
      );

    return safeSendMessage(
      chatId,

`📦 STOCK CENTRE

Available stock shown here already excludes stock reserved by unpaid orders.

Products:
${live.length}

Low stock:
${low.length}

Out of stock:
${out.length}

Choose an option.`,

      {
        reply_markup: {

          inline_keyboard: [

            [
              {
                text:
                  "📋 All Stock",

                callback_data:
                  "admin_stock_all"
              },

              {
                text:
                  "📉 Low Stock",

                callback_data:
                  "admin_stock_low"
              }
            ],

            [
              {
                text:
                  "❌ Out of Stock",

                callback_data:
                  "admin_stock_out"
              },

              {
                text:
                  "✏️ Adjust Stock",

                callback_data:
                  "admin_stock_adjust"
              }
            ],

            [
              {
                text:
                  "⬅️ Admin Dashboard",

                callback_data:
                  "admin_dashboard"
              }
            ]
          ]
        }
      }
    );
  }

  /* =======================================================
     STOCK LIST
     ======================================================= */

  async function sendStockList(
    chatId,
    title,
    list
  ) {

    const lines =
      list
        .map(
          product =>
            `#${product.id} • ${product.name}: ${product.stock}`
        )
        .join(
          "\n"
        );

    return sendLongMessage(
      chatId,

`${title}

${lines || "Nothing here."}`
    );
  }

  /* =======================================================
     SALES REPORT
     ======================================================= */

  async function sendSalesReport(
    chatId,
    days,
    title
  ) {

    const start =
      Date.now() -
      (
        days *
        24 *
        60 *
        60 *
        1000
      );

    const selected =
      [
        ...orders.values()
      ]
        .filter(
          order => {

            const created =
              new Date(
                order.createdAt ||
                0
              ).getTime();

            return (
              Number.isFinite(
                created
              ) &&
              created >=
                start
            );
          }
        );

    const paid =
      selected.filter(
        order =>
          order.paymentStatus ===
          "paid"
      );

    let revenue =
      0;

    let shipping =
      0;

    let discounts =
      0;

    let units =
      0;

    const productSales =
      new Map();

    for (
      const order
      of paid
    ) {

      revenue +=
        Number(
          order.totalPence ||
          0
        );

      shipping +=
        Number(
          order.shippingPence ||
          0
        );

      discounts +=
        Number(
          order.totalSavingsPence ||
          order.discountPence ||
          0
        );

      for (
        const item
        of order.items ||
        []
      ) {

        const quantity =
          Number(
            item.quantity ||
            0
          );

        units +=
          quantity;

        const id =
          Number(
            item.id
          );

        if (
          !productSales.has(
            id
          )
        ) {

          productSales.set(
            id,
            {
              name:
                item.name,

              units:
                0,

              value:
                0
            }
          );
        }

        const stat =
          productSales.get(
            id
          );

        stat.units +=
          quantity;

        stat.value +=
          Number(
            item.lineTotalPence ??
            (
              Number(
                item.pricePence ||
                0
              ) *
              quantity
            )
          );
      }
    }

    const average =
      paid.length
        ? Math.round(
            revenue /
            paid.length
          )
        : 0;

    const productsText =
      [
        ...productSales.values()
      ]
        .sort(
          (
            a,
            b
          ) =>
            b.units -
            a.units
        )
        .map(
          p =>
`• ${p.name}
${p.units} sold
${money(p.value)}`
        )
        .join(
          "\n\n"
        );

    return sendLongMessage(
      chatId,

`📊 ${title}

Orders created:
${selected.length}

Paid orders:
${paid.length}

Revenue:
${money(revenue)}

Average order:
${money(average)}

Shipping collected:
${money(shipping)}

Discounts:
${money(discounts)}

Units sold:
${units}

PRODUCT SALES

${productsText || "No paid sales in this period."}`
    );
  }

  /* =======================================================
     REVIEWS WAITING
     ======================================================= */

  async function sendPendingReviews(
    chatId
  ) {

    const rows =
      db.prepare(`
        SELECT *
        FROM reviews
        WHERE approved = 0
        ORDER BY id ASC
        LIMIT 20
      `)
        .all();

    if (
      !rows.length
    ) {

      return safeSendMessage(
        chatId,

`⭐ REVIEWS

No reviews are waiting for approval.`,

        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text:
                    "⬅️ Admin Dashboard",

                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }

    for (
      const review
      of rows
    ) {

      await safeSendMessage(
        chatId,

`⭐ REVIEW #${review.id}

Order:
#${review.order_id}

Customer:
${review.display_name}

Rating:
${review.rating}/5

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
              ],

              [
                {
                  text:
                    "⬅️ Admin Dashboard",

                  callback_data:
                    "admin_dashboard"
                }
              ]
            ]
          }
        }
      );
    }
  }

  /* =======================================================
     /START
     ======================================================= */

  bot.onText(
    /^\/start(?:@\w+)?(?:\s.*)?$/i,

    async msg => {

      const buttons =
        [];

      if (
        webAppUrl
      ) {

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

      if (
        isAdmin(
          msg.from?.id
        )
      ) {

        buttons.push([
          {
            text:
              "🛠 Admin Dashboard",

            callback_data:
              "admin_dashboard"
          }
        ]);
      }

      return safeSendMessage(
        msg.chat.id,

`⚡️ Welcome to Kage Supps

🛍 Open Shop
📦 My Orders
💬 Support
ℹ️ Info${
  isAdmin(msg.from?.id)
    ? "\n🛠 Admin Dashboard"
    : ""
}`,

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

        return safeSendMessage(
          msg.chat.id,

          "This command is admin-only."
        );
      }

      return sendAdminDashboard(
        msg.chat.id
      );
    }
  );

  /* =======================================================
     /MYID
     ======================================================= */

  bot.onText(
    /^\/myid(?:@\w+)?$/i,

    async msg => {

      return safeSendMessage(
        msg.chat.id,

        `Your Telegram ID: ${msg.from?.id}`
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

        return safeSendMessage(
          msg.chat.id,

          "This command is admin-only."
        );
      }

      return sendLongMessage(
        msg.chat.id,
        getAffiliateEarningsText()
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

      return sendPendingReviews(
        msg.chat.id
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

      const orderId =
        Number(
          match?.[1]
        );

      const order =
        orders.get(
          orderId
        );

      if (
        !order
      ) {

        return safeSendMessage(
          msg.chat.id,

          `❌ Order #${orderId} not found.`
        );
      }

      const result =
        await markOrderPaid(
          order
        );

      if (
        !result.ok
      ) {

        return safeSendMessage(
          msg.chat.id,

`❌ Could not mark order paid.

${result.error}`
        );
      }

      if (
        result.alreadyPaid
      ) {

        return safeSendMessage(
          msg.chat.id,

`ℹ️ Order #${orderId} was already paid.

Stock was NOT deducted again.`
        );
      }

      return safeSendMessage(
        msg.chat.id,

`✅ Order #${orderId} marked paid.

Reserved stock is now confirmed as sold.`
      );
    }
  );

  /* =======================================================
     /SETSTOCK
     ======================================================= */

  bot.onText(
    /^\/setstock(?:@\w+)?\s+(\d+)\s+(\d+)$/i,

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

      const productId =
        Number(
          match?.[1]
        );

      const newStock =
        Number(
          match?.[2]
        );

      const product =
        productsById.get(
          productId
        );

      if (
        !product
      ) {

        return safeSendMessage(
          msg.chat.id,

          "❌ Product not found."
        );
      }

      if (
        !Number.isInteger(
          newStock
        ) ||
        newStock <
          0
      ) {

        return safeSendMessage(
          msg.chat.id,

          "❌ Stock must be 0 or a positive whole number."
        );
      }

      const oldStock =
        getLiveStock(
          productId
        );

      setInventoryStmt.run(
        newStock,
        productId
      );

      return safeSendMessage(
        msg.chat.id,

`✅ STOCK UPDATED

${product.name}

Old available stock:
${oldStock}

New available stock:
${newStock}`
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

      const orderId =
        Number(
          match?.[1]
        );

      const trackingNumber =
        String(
          match?.[2] ||
          ""
        ).trim();

      const order =
        orders.get(
          orderId
        );

      if (
        !order
      ) {

        return safeSendMessage(
          msg.chat.id,

          `❌ Order #${orderId} not found.`
        );
      }

      if (
        order.paymentStatus !==
        "paid"
      ) {

        return safeSendMessage(
          msg.chat.id,

          `❌ Order #${orderId} has not been marked paid.`
        );
      }

      order.trackingNumber =
        trackingNumber;

      order.fulfilmentStatus =
        "shipped";

      order.shippedAt =
        new Date()
          .toISOString();

      saveOrder(
        order
      );

      await safeSendMessage(
        msg.chat.id,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${trackingNumber}`
      );

      if (
        order.telegramId
      ) {

        await safeSendMessage(
          order.telegramId,

`📦 Your order has been dispatched

Order:
#${orderId}

Tracking:
${trackingNumber}`
        );
      }
    }
  );

  /* =======================================================
     /SUMMARY
     ======================================================= */

  bot.onText(
    /^\/summary(?:@\w+)?$/i,

    async msg => {

      if (
        !isAdmin(
          msg.from?.id
        )
      ) {

        return;
      }

      return sendSalesReport(
        msg.chat.id,
        7,
        "7 DAY SUMMARY"
      );
    }
  );

  /* =======================================================
     CALLBACKS
     ======================================================= */

  bot.on(
    "callback_query",

    async q => {

      const chatId =
        q.message?.chat?.id;

      if (
        !chatId
      ) {
        return;
      }

      const data =
        String(
          q.data ||
          ""
        );

      try {

        await bot.answerCallbackQuery(
          q.id
        );

      } catch {}

      /* ===================================================
         REVIEW APPROVE
         =================================================== */

      if (
        data.startsWith(
          "review_approve_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const reviewId =
          Number(
            data.replace(
              "review_approve_",
              ""
            )
          );

        const review =
          db.prepare(
            `
            SELECT *
            FROM reviews
            WHERE id = ?
            `
          )
            .get(
              reviewId
            );

        if (
          !review
        ) {
          return;
        }

        db.prepare(
          `
          UPDATE reviews
          SET approved = 1
          WHERE id = ?
          `
        )
          .run(
            reviewId
          );

        return safeSendMessage(
          chatId,

          `✅ Review #${reviewId} approved.`
        );
      }

      /* ===================================================
         REVIEW REJECT
         =================================================== */

      if (
        data.startsWith(
          "review_reject_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const reviewId =
          Number(
            data.replace(
              "review_reject_",
              ""
            )
          );

        db.prepare(
          `
          DELETE FROM reviews
          WHERE id = ?
          `
        )
          .run(
            reviewId
          );

        return safeSendMessage(
          chatId,

          `❌ Review #${reviewId} rejected and removed.`
        );
      }

      /* ===================================================
         ADMIN DASHBOARD
         =================================================== */

      if (
        data ===
        "admin_dashboard"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {

          return safeSendMessage(
            chatId,
            "Admin only."
          );
        }

        return sendAdminDashboard(
          chatId
        );
      }

      /* ===================================================
         RECENT ORDERS
         =================================================== */

      if (
        data ===
        "admin_recent_orders"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return showOrderList(
          chatId,
          "📦 RECENT ORDERS",
          getRecentOrders(
            20
          )
        );
      }

      /* ===================================================
         PAYMENTS
         =================================================== */

      if (
        data ===
        "admin_payments"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getRecentOrders(
            200
          )
            .filter(
              order =>
                order.paymentStatus ===
                "payment_submitted"
            );

        return showOrderList(
          chatId,
          "⏳ PAYMENTS TO CHECK",
          list
        );
      }

      /* ===================================================
         DISPATCH
         =================================================== */

      if (
        data ===
        "admin_dispatch"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getRecentOrders(
            200
          )
            .filter(
              order =>
                order.paymentStatus ===
                  "paid" &&
                order.fulfilmentStatus !==
                  "shipped" &&
                order.fulfilmentStatus !==
                  "completed"
            );

        return showOrderList(
          chatId,
          "🚚 DISPATCH QUEUE",
          list
        );
      }

      /* ===================================================
         FIND ORDER
         =================================================== */

      if (
        data ===
        "admin_find_order"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        clearAdminInputs(
          chatId
        );

        pendingAdminOrderLookup.add(
          chatId
        );

        return safeSendMessage(
          chatId,

`🔎 FIND ORDER

Send the order number.

Example:
1030`
        );
      }

      /* ===================================================
         REPORTS
         =================================================== */

      if (
        data ===
        "admin_reports"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return safeSendMessage(
          chatId,

`📊 SALES REPORTS

Choose a period.`,

          {
            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "Today",

                    callback_data:
                      "admin_report_1"
                  },

                  {
                    text:
                      "7 Days",

                    callback_data:
                      "admin_report_7"
                  },

                  {
                    text:
                      "30 Days",

                    callback_data:
                      "admin_report_30"
                  }
                ],

                [
                  {
                    text:
                      "⬅️ Admin Dashboard",

                    callback_data:
                      "admin_dashboard"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data ===
        "admin_report_1"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          1,
          "TODAY / LAST 24 HOURS"
        );
      }

      if (
        data ===
        "admin_report_7"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          7,
          "7 DAY REPORT"
        );
      }

      if (
        data ===
        "admin_report_30"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendSalesReport(
          chatId,
          30,
          "30 DAY REPORT"
        );
      }

      /* ===================================================
         STOCK
         =================================================== */

      if (
        data ===
        "admin_stock"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return showStockCentre(
          chatId
        );
      }

      if (
        data ===
        "admin_stock_all"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendStockList(
          chatId,
          "📋 ALL STOCK",
          getLiveProducts()
        );
      }

      if (
        data ===
        "admin_stock_low"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getLiveProducts()
            .filter(
              product => {

                const stock =
                  Number(
                    product.stock
                  );

                return (
                  Number.isFinite(
                    stock
                  ) &&
                  stock >
                    0 &&
                  stock <=
                    LOW_STOCK_THRESHOLD
                );
              }
            );

        return sendStockList(
          chatId,
          "📉 LOW STOCK",
          list
        );
      }

      if (
        data ===
        "admin_stock_out"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const list =
          getLiveProducts()
            .filter(
              product =>
                Number(
                  product.stock
                ) ===
                0
            );

        return sendStockList(
          chatId,
          "❌ OUT OF STOCK",
          list
        );
      }

      if (
        data ===
        "admin_stock_adjust"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        clearAdminInputs(
          chatId
        );

        pendingStockAdjustment.set(
          chatId,
          {
            stage:
              "product"
          }
        );

        return safeSendMessage(
          chatId,

`✏️ ADJUST STOCK

Send the product ID.

Example:
123

You can find product IDs in:
Stock → All Stock`
        );
      }

      /* ===================================================
         REVIEWS
         =================================================== */

      if (
        data ===
        "admin_reviews"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendPendingReviews(
          chatId
        );
      }

      /* ===================================================
         AFFILIATE EARNINGS
         =================================================== */

      if (
        data ===
        "admin_earnings"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        return sendLongMessage(
          chatId,
          getAffiliateEarningsText()
        );
      }

      /* ===================================================
         PROMO SETTINGS
         =================================================== */

      if (
        data ===
        "admin_storewide_promo"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const promo =
          getStorewidePromo();

        return safeSendMessage(
          chatId,

`🎉 STOREWIDE PROMO

Code:
${promo.code}

Discount:
${promo.discountPercent}%

Stacks with affiliate:
YES

Switch:
${promo.active ? "🟢 ON" : "🔴 OFF"}

Currently usable:
${isStorewidePromoLive(promo) ? "🟢 YES" : "🔴 NO"}

Starts:
${promo.startsAt}

Ends:
${promo.endsAt}`,

          {
            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      promo.active
                        ? "⏸ Turn Promo Off"
                        : "▶️ Turn Promo On",

                    callback_data:
                      "admin_storewide_toggle"
                  }
                ],

                [
                  {
                    text:
                      "⬅️ Admin Dashboard",

                    callback_data:
                      "admin_dashboard"
                  }
                ]
              ]
            }
          }
        );
      }

      if (
        data ===
        "admin_storewide_toggle"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const promo =
          getStorewidePromo();

        setMetaValue(
          "storewidePromo:active",

          promo.active
            ? "false"
            : "true"
        );

        const updated =
          getStorewidePromo();

        return safeSendMessage(
          chatId,

          updated.active
            ? `✅ ${updated.code} switched ON.`
            : `⏸ ${updated.code} switched OFF.`,

          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      "🎉 Promo Settings",

                    callback_data:
                      "admin_storewide_promo"
                  }
                ]
              ]
            }
          }
        );
      }

      /* ===================================================
         ADMIN LIST
         =================================================== */

      if (
        data ===
        "admin_admins"
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const ids =
          [
            ...configuredAdminIds
          ];

        return safeSendMessage(
          chatId,

`👮 ADMINS

${ids.length
  ? ids.map(
      id =>
        `${id}${
          isOwner(id)
            ? " — OWNER"
            : ""
        }`
    ).join("\n")
  : "No admins configured."}

To add/remove admins, change the Render environment variables:

OWNER_TELEGRAM_ID

ADMIN_TELEGRAM_ID

ADMIN_TELEGRAM_IDS`
        );
      }

      /* ===================================================
         OPEN ORDER
         =================================================== */

      if (
        data.startsWith(
          "admin_order_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_order_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ===================================================
         MARK PAID
         =================================================== */

      if (
        data.startsWith(
          "admin_paid_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_paid_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        const result =
          await markOrderPaid(
            order
          );

        if (
          !result.ok
        ) {

          return safeSendMessage(
            chatId,

            `❌ ${result.error}`
          );
        }

        await safeSendMessage(
          chatId,

          result.alreadyPaid
            ? `ℹ️ Order #${orderId} was already paid.`
            : `✅ Order #${orderId} marked paid.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ===================================================
         TRACKING
         =================================================== */

      if (
        data.startsWith(
          "admin_tracking_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_tracking_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order ||
          order.paymentStatus !==
            "paid"
        ) {

          return safeSendMessage(
            chatId,
            "Paid order not found."
          );
        }

        clearAdminInputs(
          chatId
        );

        pendingAdminTracking.set(
          chatId,
          orderId
        );

        return safeSendMessage(
          chatId,

`🚚 ADD TRACKING

Order:
#${orderId}

Send the tracking number.`
        );
      }

      /* ===================================================
         ADD NOTE
         =================================================== */

      if (
        data.startsWith(
          "admin_note_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_note_",
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

        clearAdminInputs(
          chatId
        );

        pendingAdminNote.set(
          chatId,
          orderId
        );

        return safeSendMessage(
          chatId,

`📝 ADD NOTE

Order:
#${orderId}

Send the note.`
        );
      }

      /* ===================================================
         SEND REVIEW
         =================================================== */

      if (
        data.startsWith(
          "admin_review_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_review_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order ||
          order.paymentStatus !==
            "paid"
        ) {

          return safeSendMessage(
            chatId,
            "Paid order not found."
          );
        }

        if (
          !order.telegramId
        ) {

          return safeSendMessage(
            chatId,
            "This order does not have a Telegram ID."
          );
        }

        const reviewUrl =
          getReviewUrl(
            order
          );

        if (
          !reviewUrl
        ) {

          return safeSendMessage(
            chatId,
            "Could not generate the review link."
          );
        }

        await safeSendMessage(
          order.telegramId,

`⭐ We'd love your feedback

Order:
#${order.orderId}

Tap below to leave your review.`,

          {
            reply_markup: {

              inline_keyboard: [
                [
                  {
                    text:
                      "⭐ Leave a Review",

                    url:
                      reviewUrl
                  }
                ]
              ]
            }
          }
        );

        return safeSendMessage(
          chatId,

          `✅ Review link sent for order #${order.orderId}.`
        );
      }

      /* ===================================================
         CANCEL ORDER
         =================================================== */

      if (
        data.startsWith(
          "admin_cancel_"
        ) &&
        !data.startsWith(
          "admin_cancel_confirm_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_cancel_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        if (
          order.paymentStatus !==
          "awaiting_payment"
        ) {

          return safeSendMessage(
            chatId,

            "Only orders still awaiting payment can be cancelled here."
          );
        }

        return safeSendMessage(
          chatId,

`⚠️ CANCEL ORDER #${orderId}?

This will:

• cancel the order
• return reserved stock
• return eligible store credit`,

          {
            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "❌ Yes, Cancel",

                    callback_data:
                      `admin_cancel_confirm_${orderId}`
                  },

                  {
                    text:
                      "Keep Order",

                    callback_data:
                      `admin_order_${orderId}`
                  }
                ]
              ]
            }
          }
        );
      }

      /* ===================================================
         CANCEL CONFIRM
         =================================================== */

      if (
        data.startsWith(
          "admin_cancel_confirm_"
        )
      ) {

        if (
          !isAdmin(
            q.from?.id
          )
        ) {
          return;
        }

        const orderId =
          Number(
            data.replace(
              "admin_cancel_confirm_",
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

          return safeSendMessage(
            chatId,
            "Order not found."
          );
        }

        const result =
          await cancelUnpaidOrder(
            order,
            "admin_cancelled",
            true
          );

        if (
          !result.ok
        ) {

          return safeSendMessage(
            chatId,

            `❌ ${result.error}`
          );
        }

        await safeSendMessage(
          chatId,

`❌ Order #${orderId} cancelled.

Reserved stock has been returned to circulation.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ===================================================
         CUSTOMER ORDERS
         =================================================== */

      if (
        data ===
        "orders"
      ) {

        const viewer = {
          telegramId:
            q.from?.id,

          telegramUsername:
            q.from?.username
        };

        const customerOrders =
          [
            ...orders.values()
          ]
            .filter(
              order =>
                orderBelongsToViewer(
                  order,
                  viewer
                )
            )
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
            )
            .slice(
              0,
              10
            );

        if (
          !customerOrders.length
        ) {

          return safeSendMessage(
            chatId,

`📦 My Orders

No orders found yet.`
          );
        }

        const lines =
          customerOrders.map(
            order => {

              let extra =
                "";

              if (
                order.paymentStatus ===
                  "awaiting_payment" &&
                order.stockReservationExpiresAt
              ) {

                extra +=
                  `\nReservation: ${order.stockReservationExpiresAt}`;
              }

              if (
                order.trackingNumber
              ) {

                extra +=
                  `\nTracking: ${order.trackingNumber}`;
              }

              return (
                `#${order.orderId}\n` +
                `${getOrderStatusText(order)}\n` +
                `${money(order.totalPence)}` +
                extra
              );
            }
          );

        return safeSendMessage(
          chatId,

`📦 MY ORDERS

${lines.join("\n\n")}`
        );
      }

      /* ===================================================
         SUPPORT
         =================================================== */

      if (
        data ===
        "support"
      ) {

        pendingSupport.add(
          chatId
        );

        return safeSendMessage(
          chatId,

`💬 SUPPORT

Send your message below and we'll help where we can.

Alternative support:
@SuperSeiyanGoku33`
        );
      }

      /* ===================================================
         INFO
         =================================================== */

      if (
        data ===
        "info"
      ) {

        return safeSendMessage(
          chatId,

`ℹ️ SHOP INFO

Minimum basket:
£50 before discounts

Shipping:
£5

Stock reservation:
When you create an order, the items are held for ${STOCK_RESERVATION_MINUTES} minutes.

If payment isn't submitted before the reservation expires, the order is automatically cancelled and the stock returns to the shop.

Once a transaction hash is submitted, the stock remains reserved while payment is checked.`
        );
      }
    }
  );

  /* =======================================================
     TEXT INPUT HANDLER
     ======================================================= */

  bot.on(
    "message",

    async msg => {

      const chatId =
        msg.chat?.id;

      if (
        !chatId ||
        !msg.text ||
        msg.text.startsWith(
          "/"
        )
      ) {

        return;
      }

      const text =
        String(
          msg.text
        ).trim();

      /* ===================================================
         FIND ORDER
         =================================================== */

      if (
        pendingAdminOrderLookup.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        pendingAdminOrderLookup.delete(
          chatId
        );

        const orderId =
          Number(
            text.replace(
              /^#/,
              ""
            )
          );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

          return safeSendMessage(
            chatId,
            "❌ Order not found."
          );
        }

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ===================================================
         TRACKING INPUT
         =================================================== */

      if (
        pendingAdminTracking.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const orderId =
          pendingAdminTracking.get(
            chatId
          );

        pendingAdminTracking.delete(
          chatId
        );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {

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
          new Date()
            .toISOString();

        saveOrder(
          order
        );

        await safeSendMessage(
          chatId,

`✅ Tracking saved

Order:
#${orderId}

Tracking:
${text}`
        );

        if (
          order.telegramId
        ) {

          await safeSendMessage(
            order.telegramId,

`📦 Your order has been dispatched

Order:
#${orderId}

Tracking:
${text}`
          );
        }

        return;
      }

      /* ===================================================
         ADMIN NOTE
         =================================================== */

      if (
        pendingAdminNote.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const orderId =
          pendingAdminNote.get(
            chatId
          );

        pendingAdminNote.delete(
          chatId
        );

        const order =
          orders.get(
            orderId
          );

        if (
          !order
        ) {
          return;
        }

        if (
          !Array.isArray(
            order.adminNotes
          )
        ) {

          order.adminNotes =
            [];
        }

        order.adminNotes.push({
          text:
            text.slice(
              0,
              1000
            ),

          createdAt:
            new Date()
              .toISOString(),

          addedBy:
            String(
              msg.from?.id ||
              ""
            )
        });

        saveOrder(
          order
        );

        await safeSendMessage(
          chatId,

          `✅ Note added to order #${orderId}.`
        );

        return showAdminOrder(
          chatId,
          order
        );
      }

      /* ===================================================
         STOCK ADJUSTMENT
         =================================================== */

      if (
        pendingStockAdjustment.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const state =
          pendingStockAdjustment.get(
            chatId
          );

        if (
          state.stage ===
          "product"
        ) {

          const productId =
            Number(
              text.replace(
                /^#/,
                ""
              )
            );

          const product =
            productsById.get(
              productId
            );

          if (
            !product
          ) {

            return safeSendMessage(
              chatId,

`❌ Product not found.

Send another product ID.`
            );
          }

          state.stage =
            "amount";

          state.productId =
            productId;

          pendingStockAdjustment.set(
            chatId,
            state
          );

          return safeSendMessage(
            chatId,

`✏️ CHANGE STOCK

${product.name}

Current available stock:
${getLiveStock(productId)}

Send the NEW stock amount.

Examples:

0
5
20`
          );
        }

        if (
          state.stage ===
          "amount"
        ) {

          const newStock =
            Number(
              text
            );

          if (
            !Number.isInteger(
              newStock
            ) ||
            newStock <
              0
          ) {

            return safeSendMessage(
              chatId,

              "❌ Send a whole number of 0 or more."
            );
          }

          const product =
            productsById.get(
              state.productId
            );

          const oldStock =
            getLiveStock(
              state.productId
            );

          setInventoryStmt.run(
            newStock,
            state.productId
          );

          pendingStockAdjustment.delete(
            chatId
          );

          return safeSendMessage(
            chatId,

`✅ STOCK UPDATED

${product?.name || `Product #${state.productId}`}

Old available stock:
${oldStock}

New available stock:
${newStock}`,

            {
              reply_markup: {

                inline_keyboard: [
                  [
                    {
                      text:
                        "📦 Stock Centre",

                      callback_data:
                        "admin_stock"
                    },

                    {
                      text:
                        "⬅️ Dashboard",

                      callback_data:
                        "admin_dashboard"
                    }
                  ]
                ]
              }
            }
          );
        }
      }

      /* ===================================================
         SUPPORT MESSAGE
         =================================================== */

      if (
        pendingSupport.has(
          chatId
        )
      ) {

        pendingSupport.delete(
          chatId
        );

        const sender =
          msg.from?.username
            ? `@${msg.from.username}`
            : `Telegram ID ${msg.from?.id}`;

        if (
          supportTelegramIds.length
        ) {

          for (
            const supportId
            of supportTelegramIds
          ) {

            await safeSendMessage(
              supportId,

`💬 SUPPORT MESSAGE

From:
${sender}

Message:
${text}`
            );
          }

        } else {

          await sendToAdmins(
`💬 SUPPORT MESSAGE

From:
${sender}

Message:
${text}`
          );
        }

        return safeSendMessage(
          chatId,

`Thanks — your message has been sent.

Alternative support:
@SuperSeiyanGoku33`
        );
      }
    }
  );
}

/* =========================================================
   RESERVATION CLEANUP
   ========================================================= */

/*
  Run once when Render starts.
*/

expireOldReservations()
  .catch(
    err =>

      console.error(
        "INITIAL EXPIRY CHECK ERROR:",
        err
      )
  );

/*
  Then run once per minute.

  This does NOT reset the timer.

  The expiry timestamp is stored in the order,
  so Render restarting doesn't give somebody
  another 30 minutes.
*/

const reservationTimer =
  setInterval(
    () => {

      expireOldReservations()
        .catch(
          err =>

            console.error(
              "RESERVATION CLEANUP ERROR:",
              err
            )
        );
    },

    60 *
    1000
  );

reservationTimer.unref?.();

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

      return next(
        err
      );
    }

    return res
      .status(
        500
      )
      .json({
        error:
          "Internal server error."
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
      `Kage storefront running on port ${port}`
    );

    console.log(
      `Products loaded: ${products.length}`
    );

    console.log(
      `Admins loaded: ${configuredAdminIds.size}`
    );

    console.log(
      `Stock reservation: ${STOCK_RESERVATION_MINUTES} minutes`
    );

    console.log(
      `Minimum basket: ${money(MINIMUM_ORDER_PENCE)}`
    );

    console.log(
      `Shipping: ${money(SHIPPING_PENCE)}`
    );

    console.log(
      `Affiliates: ${affiliateCodes.length}`
    );
  }
);