import "dotenv/config";

import {
  readFileSync,
  mkdirSync
} from "fs";

import {
  fileURLToPath
} from "url";

import path from "path";

import {
  randomUUID
} from "crypto";

import {
  DatabaseSync
} from "node:sqlite";

import express from "express";

import TelegramBot from "node-telegram-bot-api";


/* =========================================================
   BASIC SETUP
   ========================================================= */

const __dirname =
  path.dirname(
    fileURLToPath(
      import.meta.url
    )
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

const telegramToken =
  process.env.TELEGRAM ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "";

const webAppUrl =
  process.env.WEBAPP_URL ||
  "";

const receivingAddress =
  process.env.ETH_RECEIVING_ADDRESS ||
  "";

const DATA_DIR =
  process.env.DATA_DIR ||
  ".";


/* =========================================================
   OWNER + INITIAL ADMINS
   ========================================================= */

const initialAdminIds =
  (
    process.env.ADMIN_TELEGRAM_IDS ||
    process.env.ADMIN_TELEGRAM_ID ||
    ""
  )
    .split(",")
    .map(
      id =>
        String(id)
          .trim()
    )
    .filter(Boolean);


const ownerTelegramId =
  String(
    process.env.OWNER_TELEGRAM_ID ||
    initialAdminIds[0] ||
    ""
  )
    .trim();


/* =========================================================
   SUPPORT
   ========================================================= */

const supportTelegramIds =
  (
    process.env.SUPPORT_TELEGRAM_IDS ||
    ""
  )
    .split(",")
    .map(
      id =>
        String(id)
          .trim()
    )
    .filter(Boolean);


/* =========================================================
   DEFAULT SHOP SETTINGS
   ========================================================= */

const DEFAULT_SETTINGS = {
  minimumOrderPence: 5000,
  shippingPence: 500,
  lowStockThreshold: 5,
  acceptingOrders: true
};


/* =========================================================
   AFFILIATE SETTINGS
   10% customer discount
   5% affiliate commission
   ========================================================= */

const AFFILIATE_DISCOUNT_PERCENT =
  10;

const AFFILIATE_COMMISSION_PERCENT =
  5;


/* =========================================================
   AFFILIATE CODES
   ========================================================= */

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
  }
];


/* =========================================================
   EXPRESS
   ========================================================= */

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


/* =========================================================
   TABLES

   IMPORTANT:
   cart_events keeps your EXISTING productId / createdAt names.
   ========================================================= */

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

CREATE TABLE IF NOT EXISTS inventory (
  product_id INTEGER PRIMARY KEY,
  stock INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  telegram_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'admin',
  active INTEGER NOT NULL DEFAULT 1,
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


const insertActivityStmt =
  db.prepare(`
    INSERT INTO activity_log (
      admin_id,
      action,
      details,
      created_at
    )
    VALUES (?, ?, ?, ?)
  `);


/*
  IMPORTANT:
  Existing DB uses productId and createdAt.
*/
const insertCartEventStmt =
  db.prepare(`
    INSERT INTO cart_events (
      productId,
      action,
      createdAt
    )
    VALUES (?, ?, ?)
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


  if (
    !Array.isArray(
      products
    )
  ) {

    throw new Error(
      "products.json must contain an array."
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
        Number(
          product.id
        ),
        product
      ]
    )
  );


/* =========================================================
   INITIAL INVENTORY
   ========================================================= */

for (
  const product
  of products
) {

  const id =
    Number(
      product.id
    );


  const stock =
    Number(
      product.stock
    );


  if (
    Number.isInteger(
      id
    ) &&
    Number.isFinite(
      stock
    )
  ) {

    insertInventoryStmt.run(
      id,
      Math.max(
        0,
        Math.floor(
          stock
        )
      )
    );
  }
}


/* =========================================================
   MEMORY
   ========================================================= */

const orders =
  new Map();

const discountCodes =
  new Map();

const referralEarnings =
  new Map();


/* =========================================================
   LOAD ORDERS
   ========================================================= */

for (
  const row
  of db
    .prepare(`
      SELECT id, json
      FROM orders
    `)
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

  } catch {}
}


/* =========================================================
   LOAD DISCOUNTS
   ========================================================= */

for (
  const row
  of db
    .prepare(`
      SELECT code, json
      FROM discount_codes
    `)
    .all()
) {

  try {

    discountCodes.set(
      String(
        row.code
      )
        .toUpperCase(),

      JSON.parse(
        row.json
      )
    );

  } catch {}
}


/* =========================================================
   LOAD REFERRAL / AFFILIATE EARNINGS
   ========================================================= */

for (
  const row
  of db
    .prepare(`
      SELECT code, json
      FROM referral_earnings
    `)
    .all()
) {

  try {

    referralEarnings.set(
      String(
        row.code
      )
        .toUpperCase(),

      JSON.parse(
        row.json
      )
    );

  } catch {}
}


/* =========================================================
   META HELPERS
   ========================================================= */

function getMeta(
  key,
  fallback = null
) {

  const row =
    db
      .prepare(`
        SELECT value
        FROM meta
        WHERE key = ?
      `)
      .get(
        key
      );


  if (
    !row
  ) {

    return fallback;
  }


  return row.value;
}


function setMeta(
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
   ORDER NUMBER
   ========================================================= */

let nextOrderId =
  Number(
    getMeta(
      "nextOrderId",
      "1001"
    )
  ) ||
  1001;


function saveNextOrderId(
  value
) {

  nextOrderId =
    value;


  setMeta(
    "nextOrderId",
    value
  );
}


/* =========================================================
   DEFAULT SETTINGS
   ========================================================= */

for (
  const [
    key,
    value
  ]
  of Object.entries(
    DEFAULT_SETTINGS
  )
) {

  if (
    getMeta(
      `setting:${key}`
    ) ===
    null
  ) {

    setMeta(
      `setting:${key}`,
      value
    );
  }
}


/* =========================================================
   SETTINGS HELPERS
   ========================================================= */

function getSettingNumber(
  key,
  fallback
) {

  const value =
    Number(
      getMeta(
        `setting:${key}`,
        fallback
      )
    );


  if (
    !Number.isFinite(
      value
    )
  ) {

    return fallback;
  }


  return value;
}


function getSettingBoolean(
  key,
  fallback
) {

  const value =
    getMeta(
      `setting:${key}`,
      fallback
        ? "true"
        : "false"
    );


  return (
    String(
      value
    ) ===
    "true"
  );
}


function getShopSettings() {

  return {

    minimumOrderPence:
      getSettingNumber(
        "minimumOrderPence",
        DEFAULT_SETTINGS
          .minimumOrderPence
      ),

    shippingPence:
      getSettingNumber(
        "shippingPence",
        DEFAULT_SETTINGS
          .shippingPence
      ),

    lowStockThreshold:
      getSettingNumber(
        "lowStockThreshold",
        DEFAULT_SETTINGS
          .lowStockThreshold
      ),

    acceptingOrders:
      getSettingBoolean(
        "acceptingOrders",
        DEFAULT_SETTINGS
          .acceptingOrders
      )
  };
}


/* =========================================================
   GENERAL HELPERS
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


function deleteOrder(
  orderId
) {

  db
    .prepare(`
      DELETE FROM orders
      WHERE id = ?
    `)
    .run(
      Number(
        orderId
      )
    );


  orders.delete(
    Number(
      orderId
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


function logActivity(
  adminId,
  action,
  details = ""
) {

  insertActivityStmt.run(

    String(
      adminId ||
      ""
    ),

    String(
      action ||
      ""
    ),

    String(
      details ||
      ""
    )
      .slice(
        0,
        2000
      ),

    new Date()
      .toISOString()
  );
}


/* =========================================================
   ADMIN DATABASE
   ========================================================= */

function seedAdmin(
  telegramId,
  role,
  addedBy = "environment"
) {

  if (
    !telegramId
  ) {
    return;
  }


  db
    .prepare(`
      INSERT INTO admins (
        telegram_id,
        role,
        active,
        added_at,
        added_by
      )
      VALUES (?, ?, 1, ?, ?)

      ON CONFLICT(telegram_id)
      DO UPDATE SET
        active = 1
    `)
    .run(

      String(
        telegramId
      ),

      role,

      new Date()
        .toISOString(),

      String(
        addedBy
      )
    );
}


if (
  ownerTelegramId
) {

  seedAdmin(
    ownerTelegramId,
    "owner"
  );


  db
    .prepare(`
      UPDATE admins
      SET
        role = 'owner',
        active = 1
      WHERE telegram_id = ?
    `)
    .run(
      ownerTelegramId
    );
}


for (
  const id
  of initialAdminIds
) {

  if (
    id ===
    ownerTelegramId
  ) {
    continue;
  }


  seedAdmin(
    id,
    "admin"
  );
}


function getAdmins() {

  return db
    .prepare(`
      SELECT *
      FROM admins
      WHERE active = 1
      ORDER BY
        CASE
          WHEN role = 'owner'
          THEN 0
          ELSE 1
        END,
        added_at ASC
    `)
    .all();
}


function isAdmin(
  userId
) {

  if (
    !userId
  ) {
    return false;
  }


  const row =
    db
      .prepare(`
        SELECT telegram_id
        FROM admins
        WHERE telegram_id = ?
          AND active = 1
      `)
      .get(
        String(
          userId
        )
      );


  return Boolean(
    row
  );
}


function isOwner(
  userId
) {

  if (
    !userId
  ) {
    return false;
  }


  const row =
    db
      .prepare(`
        SELECT role
        FROM admins
        WHERE telegram_id = ?
          AND active = 1
      `)
      .get(
        String(
          userId
        )
      );


  return (
    row?.role ===
    "owner"
  );
}


function addAdmin(
  telegramId,
  addedBy
) {

  const id =
    String(
      telegramId
    )
      .trim();


  if (
    !/^\d+$/.test(
      id
    )
  ) {

    return false;
  }


  seedAdmin(
    id,
    "admin",
    addedBy
  );


  return true;
}


function removeAdmin(
  telegramId
) {

  const id =
    String(
      telegramId
    );


  if (
    id ===
    ownerTelegramId
  ) {

    return false;
  }


  db
    .prepare(`
      UPDATE admins
      SET active = 0
      WHERE telegram_id = ?
        AND role != 'owner'
    `)
    .run(
      id
    );


  return true;
}


/* =========================================================
   INVENTORY HELPERS
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


  return row
    ? Number(
        row.stock
      )
    : null;
}


function getLiveProducts() {

  return products.map(
    product => ({

      ...product,

      stock:
        getLiveStock(
          product.id
        ) ??
        Number(
          product.stock ||
          0
        )
    })
  );
}


/* =========================================================
   ORDER HELPERS
   ========================================================= */

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


function getOrderStatusText(
  order
) {

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


/* =========================================================
   ORDER TIMELINE
   ========================================================= */

function ensureTimeline(
  order
) {

  if (
    !Array.isArray(
      order.timeline
    )
  ) {

    order.timeline =
      [];
  }
}


function addTimeline(
  order,
  status,
  by = "system",
  details = ""
) {

  ensureTimeline(
    order
  );


  order.timeline.push({

    status,

    by:
      String(
        by
      ),

    details:
      String(
        details ||
        ""
      ),

    createdAt:
      new Date()
        .toISOString()
  });
}


/* =========================================================
   DISCOUNT
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
            record.discountValue
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
   RESTORE STORE CREDIT
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

    return false;
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

    return false;
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


  return true;
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
    ) || {

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
   AFFILIATE CODE SETUP

   Existing earnings are PRESERVED.
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
   TELEGRAM BOT
   ========================================================= */

let bot =
  null;


if (
  telegramToken
) {

  try {

    bot =
      new TelegramBot(
        telegramToken,
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

  const admins =
    getAdmins();


  for (
    const admin
    of admins
  ) {

    await safeSendMessage(
      admin.telegram_id,
      message,
      options
    );
  }
}


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


  const lines =
    message.split(
      "\n"
    );


  let chunk =
    "";


  for (
    const line
    of lines
  ) {

    const next =
      chunk
        ? `${chunk}\n${line}`
        : line;


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
        line;

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


/* =========================================================
   AFFILIATE EARNINGS DISPLAY
   ========================================================= */

function getAffiliateEarningsText() {

  let totalBalancePence =
    0;

  let totalEarnedPence =
    0;

  let totalPaidOutPence =
    0;


  const lines =
    [];


  for (
    const affiliate
    of affiliateCodes
  ) {

    const record =
      referralEarnings.get(
        affiliate.code
      );


    const balance =
      Number(
        record?.balancePence ||
        0
      );


    const lifetime =
      Number(
        record?.totalEarnedPence ||
        0
      );


    const paidOut =
      Number(
        record?.paidOutPence ||
        0
      );


    totalBalancePence +=
      balance;


    totalEarnedPence +=
      lifetime;


    totalPaidOutPence +=
      paidOut;


    lines.push(
`👤 ${affiliate.owner}
Code: ${affiliate.code}

Currently owed:
${money(balance)}

Lifetime earned:
${money(lifetime)}

Paid out:
${money(paidOut)}`
    );
  }


  return (
`💰 AFFILIATE EARNINGS

${lines.join("\n\n")}

━━━━━━━━━━━━━━

TOTAL CURRENTLY OWED:
${money(totalBalancePence)}

TOTAL AFFILIATE EARNINGS:
${money(totalEarnedPence)}

TOTAL PAID OUT:
${money(totalPaidOutPence)}`
  );
}


/* =========================================================
   STOCK ALERTS
   ========================================================= */

async function alertStockChange(
  product,
  previousStock,
  newStock
) {

  if (
    !product
  ) {
    return;
  }


  const settings =
    getShopSettings();


  if (
    Number(
      newStock
    ) ===
      0 &&
    Number(
      previousStock
    ) !==
      0
  ) {

    await sendToAdmins(

`❌ OUT OF STOCK

${product.name}

Product ID:
${product.id}

Stock:
0`
    );


    return;
  }


  if (
    Number(
      newStock
    ) >
      0 &&
    Number(
      newStock
    ) <=
      settings.lowStockThreshold &&
    Number(
      previousStock
    ) >
      settings.lowStockThreshold
  ) {

    await sendToAdmins(

`📉 LOW STOCK ALERT

${product.name}

Product ID:
${product.id}

Remaining:
${newStock}

Alert level:
${settings.lowStockThreshold}`
    );
  }
}


/* =========================================================
   DEDUCT STOCK
   ========================================================= */

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
          `Not enough stock remaining for ${item.name}. Available: ${stock}.`
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
    new Date()
      .toISOString();


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
        "Invalid GBP/USDT rate"
      );
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


  return (
    `${webAppUrl.replace(
      /\/+$/,
      ""
    )}/review/${order.orderId}` +
    `?token=${encodeURIComponent(
      order.reviewToken
    )}`
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
        "This order has been cancelled."
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
    new Date()
      .toISOString();


  addTimeline(
    order,
    "paid",
    adminId,
    "Payment confirmed"
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


  logActivity(
    adminId,
    "MARK_PAID",
    `Order #${order.orderId}`
  );


  await sendToAdmins(

`✅ PAYMENT CONFIRMED

Order:
#${order.orderId}

Customer:
${order.customerName}

Total:
${money(
  order.totalPence
)}

${
  order.discountCode &&
  order.referralCommissionPence
    ? `Affiliate:
${order.referralOwner}

Code:
${order.discountCode}

Commission:
${money(
  order.referralCommissionPence
)}

`
    : ""
}Status:
Needs packing 🧺`
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
${money(
  order.totalPence
)}

Your order is now being prepared.`
    );
  }


  return {
    ok:
      true
  };
}


/* =========================================================
   PRODUCTS
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


/* =========================================================
   SHOP STATUS
   ========================================================= */

app.get(
  "/api/shop-status",

  (
    _req,
    res
  ) => {

    const settings =
      getShopSettings();


    res.json({

      acceptingOrders:
        settings.acceptingOrders,

      minimumOrderPence:
        settings.minimumOrderPence,

      shippingPence:
        settings.shippingPence
    });
  }
);


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  "/health",

  (
    _req,
    res
  ) => {

    const settings =
      getShopSettings();


    res.json({

      ok:
        true,

      products:
        products.length,

      orders:
        orders.size,

      admins:
        getAdmins()
          .length,

      affiliates:
        affiliateCodes.length,

      telegramConfigured:
        Boolean(
          telegramToken
        ),

      paymentAddressConfigured:
        Boolean(
          receivingAddress
        ),

      acceptingOrders:
        settings.acceptingOrders,

      minimumOrderPence:
        settings.minimumOrderPence,

      shippingPence:
        settings.shippingPence,

      lowStockThreshold:
        settings.lowStockThreshold
    });
  }
);


/* =========================================================
   STATIC
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
        .status(400)
        .json({
          error:
            "Invalid cart event"
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

      const settings =
        getShopSettings();


      if (
        !settings.acceptingOrders
      ) {

        return res
          .status(503)
          .json({

            error:
              "Checkout is temporarily paused."
          });
      }


      const {
        customerName,
        telegramUsername,
        telegramId,
        address,
        items,
        discountCode,
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
          .status(400)
          .json({

            error:
              "Missing order details"
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
            .status(400)
            .json({

              error:
                "Invalid item in basket"
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
            .status(400)
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
            .status(400)
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
        settings.minimumOrderPence
      ) {

        return res
          .status(400)
          .json({

            error:
              `Minimum basket is ${money(
                settings.minimumOrderPence
              )} before discount and shipping.`
          });
      }


      let discountPence =
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

          discountPence =
            calculateDiscount(
              subtotalPence,
              record
            );


          appliedDiscountCode =
            code;


          if (
            record.referralOwner &&
            Number(
              record.commissionPercent
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


      let storeCreditPence =
        0;


      let appliedStoreCreditCode =
        null;


      if (
        storeCreditCode
      ) {

        const code =
          normaliseCode(
            storeCreditCode
          );


        const credit =
          referralEarnings.get(
            code
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
              discountPence
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

            appliedStoreCreditCode =
              code;


            credit.balancePence =
              Number(
                credit.balancePence ||
                0
              ) -
              storeCreditPence;


            saveReferralEarnings(
              code,
              credit
            );
          }
        }
      }


      const shippingPence =
        settings.shippingPence;


      const totalPence =
        Math.max(
          0,

          subtotalPence -
          discountPence -
          storeCreditPence
        ) +
        shippingPence;


      const orderId =
        nextOrderId;


      saveNextOrderId(
        nextOrderId +
        1
      );


      const quotedUsdt =
        await getUsdtQuote(
          totalPence
        );


      const order = {

        orderId,

        customerName:
          String(
            customerName
          )
            .trim(),

        telegramUsername:
          telegramUsername ||
          "",

        telegramId:
          telegramId ||
          null,

        address:
          String(
            address
          )
            .trim(),

        items:
          lineItems,

        subtotalPence,

        discountPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        discountCode:
          appliedDiscountCode,

        storeCreditCode:
          appliedStoreCreditCode,

        storeCreditRestored:
          false,

        referralOwner,

        referralCommissionPence,

        referralCredited:
          false,

        stockDeducted:
          false,

        paymentStatus:
          "awaiting_payment",

        fulfilmentStatus:
          "not_shipped",

        quotedUsdt,

        transactionId:
          null,

        trackingNumber:
          null,

        adminNotes:
          [],

        timeline:
          [],

        reviewToken:
          randomUUID(),

        createdAt:
          new Date()
            .toISOString()
      };


      addTimeline(
        order,
        "created",
        "customer",
        "Order created"
      );


      addTimeline(
        order,
        "awaiting_payment",
        "system",
        "Awaiting payment"
      );


      saveOrder(
        order
      );


      const itemLines =
        lineItems
          .map(
            item =>
              `${item.quantity} × ${item.name}`
          )
          .join("\n");


      await sendToAdmins(

`🧾 NEW ORDER

Order:
#${orderId}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(
        order.telegramUsername
      )}`
    : (
        order.telegramId ||
        "Not supplied"
      )
}

📍 Address:
${order.address}

Items:
${itemLines}

Basket:
${money(
  subtotalPence
)}

Discount:
-${money(
  discountPence
)}

Store credit:
-${money(
  storeCreditPence
)}

Shipping:
${money(
  shippingPence
)}

TOTAL:
${money(
  totalPence
)}

${
  appliedDiscountCode
    ? `Code:
${appliedDiscountCode}`
    : `Code:
None`
}

${
  referralCommissionPence >
  0
    ? `
Affiliate:
${referralOwner}

Commission once paid:
${money(
  referralCommissionPence
)}`
    : ""
}

Status:
Awaiting payment`
      );


      return res.json({

        ok:
          true,

        orderId,

        subtotalPence,

        discountPence,

        storeCreditPence,

        shippingPence,

        totalPence,

        status:
          order.paymentStatus,

        payment: {

          method:
            "crypto",

          network:
            "ERC-20",

          address:
            receivingAddress,

          quote: {

            USDT:
              quotedUsdt ||
              "QUOTE_PENDING"
          },

          instructions:
            receivingAddress
              ? (
                  quotedUsdt
                    ? `Send ${quotedUsdt} USDT using Ethereum ERC-20 only, then submit the transaction hash.`
                    : "Payment quote is temporarily unavailable."
                )
              : "Payment address is not configured."
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
        .status(404)
        .json({

          error:
            "Order not found"
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
        null
    });
  }
);


/* =========================================================
   PAYMENT HASH SUBMISSION

   Submitted does NOT mean confirmed.
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
        .status(404)
        .json({

          error:
            "Order not found"
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
      !/^0x[a-fA-F0-9]{64}$/.test(
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


    const alreadyUsed =
      [
        ...orders.values()
      ]
        .some(
          existing =>

            existing.orderId !==
              order.orderId &&

            String(
              existing.transactionId ||
              ""
            )
              .toLowerCase() ===

            transactionId
              .toLowerCase()
        );


    if (
      alreadyUsed
    ) {

      return res
        .status(400)
        .json({

          error:
            "That transaction has already been used."
        });
    }


    order.transactionId =
      transactionId;


    order.paymentStatus =
      "payment_submitted";


    order.paymentSubmittedAt =
      new Date()
        .toISOString();


    addTimeline(
      order,
      "payment_submitted",
      "customer",
      transactionId
    );


    saveOrder(
      order
    );


    await sendToAdmins(

`💳 PAYMENT SUBMITTED

Order:
#${order.orderId}

Customer:
${order.customerName}

Expected:
${money(
  order.totalPence
)}

Transaction:
${transactionId}

Verify payment independently before marking the order paid.`
    );


    return res.json({

      ok:
        true,

      orderId:
        order.orderId,

      status:
        "payment_submitted",

      message:
        "Payment submitted for confirmation."
    });
  }
);


/* =========================================================
   REVIEWS API
   ========================================================= */

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
          LIMIT 100
        `)
        .all();


    return res.json(
      rows
    );
  }
);


app.post(
  "/api/reviews",

  async (
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


    const rating =
      Number(
        req.body?.rating
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
        .status(404)
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
        .status(403)
        .json({

          error:
            "Reviews can be left after payment is confirmed."
        });
    }


    if (
      token !==
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
      !Number.isInteger(
        rating
      ) ||
      rating <
        1 ||
      rating >
        5
    ) {

      return res
        .status(400)
        .json({

          error:
            "Rating must be between 1 and 5."
        });
    }


    if (
      !reviewText
    ) {

      return res
        .status(400)
        .json({

          error:
            "Please enter a review."
        });
    }


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
      db
        .prepare(`
          SELECT *
          FROM reviews
          WHERE order_id = ?
        `)
        .get(
          orderId
        );


    if (
      review
    ) {

      await sendToAdmins(

`⭐ NEW REVIEW

Review:
#${review.id}

Order:
#${orderId}

Customer:
${displayName}

Rating:
${rating}/5

${reviewText}`,

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


    const token =
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
      token !==
        order.reviewToken
    ) {

      return res
        .status(404)
        .send(
          "Review link not found."
        );
    }


    if (
      order.paymentStatus !==
      "paid"
    ) {

      return res
        .status(403)
        .send(
          "Payment must be confirmed before leaving a review."
        );
    }


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
  content="width=device-width,initial-scale=1"
>

<title>
Leave a Review
</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #ffffff;
  color: #111111;
  padding: 24px;
}

.card {
  max-width: 520px;
  margin: 30px auto;
  padding: 24px;
  border: 1px solid #c9a227;
  border-radius: 18px;
}

input,
select,
textarea,
button {
  box-sizing: border-box;
  width: 100%;
  padding: 13px;
  margin-top: 12px;
  font-size: 16px;
}

textarea {
  min-height: 130px;
}

button {
  border: 0;
  border-radius: 10px;
  background: #c9a227;
  color: white;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="card">

<h1>
⭐ Leave a Review
</h1>

<p>
Order #${orderId}
</p>

<input
  id="name"
  placeholder="Your name"
  maxlength="50"
>

<select id="rating">

<option value="5">
★★★★★ - 5
</option>

<option value="4">
★★★★☆ - 4
</option>

<option value="3">
★★★☆☆ - 3
</option>

<option value="2">
★★☆☆☆ - 2
</option>

<option value="1">
★☆☆☆☆ - 1
</option>

</select>

<textarea
  id="review"
  placeholder="Tell us about your experience..."
  maxlength="1000"
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
  ${JSON.stringify(
    token
  )};


document
  .getElementById(
    "submit"
  )
  .onclick =
  async () => {

    const button =
      document
        .getElementById(
          "submit"
        );

    const message =
      document
        .getElementById(
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
                    .getElementById(
                      "name"
                    )
                    .value,

                rating:
                  Number(
                    document
                      .getElementById(
                        "rating"
                      )
                      .value
                  ),

                reviewText:
                  document
                    .getElementById(
                      "review"
                    )
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

    } catch (err) {

      message.textContent =
        err.message;

      button.disabled =
        false;
    }
  };

</script>

</body>
</html>
    `);
  }
);


/* =========================================================
   CSV HELPERS
   ========================================================= */

function csvEscape(
  value
) {

  const text =
    String(
      value ??
      ""
    );


  return `"${text.replace(
    /"/g,
    '""'
  )}"`;
}


function buildOrdersCsv() {

  const rows = [

    [
      "Order",
      "Created",
      "Customer",
      "Telegram",
      "Payment Status",
      "Fulfilment Status",
      "Subtotal",
      "Discount",
      "Discount Code",
      "Affiliate",
      "Affiliate Commission",
      "Store Credit",
      "Shipping",
      "Total",
      "Tracking"
    ]
      .map(
        csvEscape
      )
      .join(",")
  ];


  for (
    const order
    of getSortedOrders()
  ) {

    rows.push(

      [
        order.orderId,

        order.createdAt,

        order.customerName,

        order.telegramUsername ||
        order.telegramId ||
        "",

        order.paymentStatus,

        order.fulfilmentStatus,

        (
          Number(
            order.subtotalPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            order.discountPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        order.discountCode ||
        "",

        order.referralOwner ||
        "",

        (
          Number(
            order.referralCommissionPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            order.storeCreditPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            order.shippingPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            order.totalPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        order.trackingNumber ||
        ""
      ]
        .map(
          csvEscape
        )
        .join(",")
    );
  }


  return rows.join(
    "\n"
  );
}


function buildInventoryCsv() {

  const rows = [

    [
      "ID",
      "Name",
      "Stock",
      "Price"
    ]
      .map(
        csvEscape
      )
      .join(",")
  ];


  for (
    const product
    of getLiveProducts()
  ) {

    rows.push(

      [
        product.id,

        product.name,

        product.stock,

        (
          Number(
            product.pricePence ||
            0
          ) /
          100
        )
          .toFixed(2)
      ]
        .map(
          csvEscape
        )
        .join(",")
    );
  }


  return rows.join(
    "\n"
  );
}


function buildAffiliateCsv() {

  const rows = [

    [
      "Code",
      "Affiliate",
      "Currently Owed",
      "Lifetime Earned",
      "Paid Out"
    ]
      .map(
        csvEscape
      )
      .join(",")
  ];


  for (
    const affiliate
    of affiliateCodes
  ) {

    const record =
      referralEarnings.get(
        affiliate.code
      );


    rows.push(

      [
        affiliate.code,

        affiliate.owner,

        (
          Number(
            record?.balancePence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            record?.totalEarnedPence ||
            0
          ) /
          100
        )
          .toFixed(2),

        (
          Number(
            record?.paidOutPence ||
            0
          ) /
          100
        )
          .toFixed(2)
      ]
        .map(
          csvEscape
        )
        .join(",")
    );
  }


  return rows.join(
    "\n"
  );
}


/* =========================================================
   BOT INPUT STATES
   ========================================================= */

const pendingSupport =
  new Set();

const pendingOrderSearch =
  new Set();

const pendingCustomerSearch =
  new Set();

const pendingTracking =
  new Map();

const pendingAdminNote =
  new Map();

const pendingStockAdjustment =
  new Map();

const pendingSettingChange =
  new Map();

const pendingDiscountCreation =
  new Map();

const pendingAdminManagement =
  new Map();

const pendingAnnouncement =
  new Map();


/* =========================================================
   TELEGRAM UI
   ========================================================= */

if (
  bot
) {


  function clearAdminInputs(
    chatId
  ) {

    pendingOrderSearch.delete(
      chatId
    );

    pendingCustomerSearch.delete(
      chatId
    );

    pendingTracking.delete(
      chatId
    );

    pendingAdminNote.delete(
      chatId
    );

    pendingStockAdjustment.delete(
      chatId
    );

    pendingSettingChange.delete(
      chatId
    );

    pendingDiscountCreation.delete(
      chatId
    );

    pendingAdminManagement.delete(
      chatId
    );

    pendingAnnouncement.delete(
      chatId
    );
  }


  /* =======================================================
     ADMIN DASHBOARD
     ======================================================= */

  function adminDashboardButtons() {

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
                "admin_settings"
            },

            {
              text:
                "👮 Admins",

              callback_data:
                "admin_manage_admins"
            }
          ]
        ]
      }
    };
  }


  async function sendAdminDashboard(
    chatId
  ) {

    clearAdminInputs(
      chatId
    );


    const all =
      getSortedOrders();


    const awaiting =
      all
        .filter(
          order =>
            order.paymentStatus ===
            "awaiting_payment"
        )
        .length;


    const submitted =
      all
        .filter(
          order =>
            order.paymentStatus ===
            "payment_submitted"
        )
        .length;


    const packing =
      all
        .filter(
          order =>
            order.fulfilmentStatus ===
            "needs_packing"
        )
        .length;


    const dispatch =
      all
        .filter(
          order =>
            order.fulfilmentStatus ===
            "packed"
        )
        .length;


    const settings =
      getShopSettings();


    return safeSendMessage(
      chatId,

`🛠 ADMIN DASHBOARD

🕐 Awaiting payment:
${awaiting}

⏳ Payment submitted:
${submitted}

🧺 Needs packing:
${packing}

🚚 Ready to dispatch:
${dispatch}

Shop:
${
  settings.acceptingOrders
    ? "🟢 Accepting orders"
    : "🔴 Checkout paused"
}

Affiliates:
${affiliateCodes.length}

Admins:
${getAdmins().length}`,

      adminDashboardButtons()
    );
  }


  /* =======================================================
     ORDER BUTTONS
     ======================================================= */

  function adminOrderButtons(
    order
  ) {

    const rows =
      [];


    if (
      order.paymentStatus !==
        "paid" &&
      order.paymentStatus !==
        "cancelled"
    ) {

      rows.push([
        {
          text:
            "✅ Mark Paid",

          callback_data:
            `admin_paid_${order.orderId}`
        }
      ]);
    }


    if (
      order.fulfilmentStatus ===
      "needs_packing"
    ) {

      rows.push([
        {
          text:
            "📦 Mark Packed",

          callback_data:
            `admin_pack_${order.orderId}`
        }
      ]);
    }


    if (
      order.fulfilmentStatus ===
      "packed"
    ) {

      rows.push([
        {
          text:
            "🚚 Add Tracking / Dispatch",

          callback_data:
            `admin_tracking_${order.orderId}`
        }
      ]);
    }


    if (
      order.fulfilmentStatus ===
      "shipped"
    ) {

      rows.push([
        {
          text:
            "✅ Mark Completed",

          callback_data:
            `admin_complete_${order.orderId}`
        }
      ]);
    }


    rows.push([
      {
        text:
          "🕒 Timeline",

        callback_data:
          `admin_timeline_${order.orderId}`
      },

      {
        text:
          "📝 Note",

        callback_data:
          `admin_note_${order.orderId}`
      }
    ]);


    if (
      order.paymentStatus ===
      "paid"
    ) {

      rows.push([
        {
          text:
            "⭐ Send Review Link",

          callback_data:
            `admin_review_${order.orderId}`
        }
      ]);
    }


    if (
      order.paymentStatus ===
      "awaiting_payment"
    ) {

      rows.push([
        {
          text:
            "❌ Cancel Order",

          callback_data:
            `admin_cancel_${order.orderId}`
        }
      ]);
    }


    if (
      order.paymentStatus ===
      "cancelled"
    ) {

      rows.push([
        {
          text:
            "🗑 Delete Cancelled Order",

          callback_data:
            `admin_delete_${order.orderId}`
        }
      ]);
    }


    rows.push([
      {
        text:
          "⬅️ Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);


    return {

      reply_markup: {

        inline_keyboard:
          rows
      }
    };
  }


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
            `${item.quantity} × ${item.name}`
        )
        .join("\n") ||
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
            .join("\n")
        : "None";


    return safeSendMessage(
      chatId,

`📦 ORDER #${order.orderId}

Status:
${getOrderStatusText(
  order
)}

Customer:
${order.customerName}

Telegram:
${
  order.telegramUsername
    ? `@${normaliseUsername(
        order.telegramUsername
      )}`
    : (
        order.telegramId ||
        "Not supplied"
      )
}

📍 Address:
${order.address}

Items:
${items}

Basket:
${money(
  order.subtotalPence
)}

Discount:
-${money(
  order.discountPence
)}

Discount code:
${order.discountCode || "None"}

Affiliate:
${order.referralOwner || "None"}

Affiliate commission:
${money(
  order.referralCommissionPence ||
  0
)}

Store credit:
-${money(
  order.storeCreditPence
)}

Shipping:
${money(
  order.shippingPence
)}

TOTAL:
${money(
  order.totalPence
)}

Transaction:
${order.transactionId || "None"}

Tracking:
${order.trackingNumber || "None"}

Notes:
${notes}`,

      adminOrderButtons(
        order
      )
    );
  }


  /* =======================================================
     ORDER LIST
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


    const buttons =
      list
        .slice(
          0,
          25
        )
        .map(
          order => [

            {
              text:
                `#${order.orderId} • ${order.customerName} • ${money(
                  order.totalPence
                )}`,

              callback_data:
                `admin_order_${order.orderId}`
            }
          ]
        );


    buttons.push([
      {
        text:
          "⬅️ Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);


    return safeSendMessage(
      chatId,

`${title}

Tap an order.`,

      {

        reply_markup: {

          inline_keyboard:
            buttons
        }
      }
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

    const all =
      getSortedOrders();


    const selected =
      days ===
        null
        ? all
        : all.filter(
            order =>

              new Date(
                order.createdAt ||
                0
              )
                .getTime() >=

              Date.now() -
              (
                days *
                86400000
              )
          );


    const paid =
      selected
        .filter(
          order =>
            order.paymentStatus ===
            "paid"
        );


    const revenuePence =
      paid.reduce(
        (
          total,
          order
        ) =>
          total +
          Number(
            order.totalPence ||
            0
          ),

        0
      );


    const shippingPence =
      paid.reduce(
        (
          total,
          order
        ) =>
          total +
          Number(
            order.shippingPence ||
            0
          ),

        0
      );


    const discountsPence =
      paid.reduce(
        (
          total,
          order
        ) =>
          total +
          Number(
            order.discountPence ||
            0
          ),

        0
      );


    const affiliateCommissionPence =
      paid.reduce(
        (
          total,
          order
        ) =>
          total +
          Number(
            order.referralCommissionPence ||
            0
          ),

        0
      );


    const productStats =
      new Map();


    for (
      const order
      of paid
    ) {

      for (
        const item
        of order.items ||
        []
      ) {

        const key =
          Number(
            item.id
          );


        if (
          !productStats.has(
            key
          )
        ) {

          productStats.set(
            key,
            {

              name:
                item.name,

              units:
                0,

              revenue:
                0
            }
          );
        }


        const stat =
          productStats.get(
            key
          );


        stat.units +=
          Number(
            item.quantity ||
            0
          );


        stat.revenue +=
          Number(
            item.lineTotalPence ||
            0
          );
      }
    }


    const average =
      paid.length
        ? Math.round(
            revenuePence /
            paid.length
          )
        : 0;


    const bestSellers =
      [
        ...productStats.values()
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
          product =>
            `• ${product.name}: ${product.units} sold • ${money(
              product.revenue
            )}`
        )
        .join("\n");


    return sendLongMessage(
      chatId,

`📊 ${title}

Orders created:
${selected.length}

Paid orders:
${paid.length}

Revenue:
${money(
  revenuePence
)}

Average paid order:
${money(
  average
)}

Shipping collected:
${money(
  shippingPence
)}

Discounts:
${money(
  discountsPence
)}

Affiliate commission generated:
${money(
  affiliateCommissionPence
)}

BEST SELLERS

${
  bestSellers ||
  "No paid sales in this period."
}`
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


    const threshold =
      getShopSettings()
        .lowStockThreshold;


    const low =
      live.filter(
        product =>
          Number(
            product.stock
          ) >
            0 &&
          Number(
            product.stock
          ) <=
            threshold
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

Products:
${live.length}

Low stock:
${low.length}

Out of stock:
${out.length}`,

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
                  "✏️ Change Stock",

                callback_data:
                  "admin_stock_adjust"
              }
            ],

            [
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


  async function sendStockList(
    chatId,
    title,
    list
  ) {

    const text =
      list
        .map(
          product =>
            `#${product.id} • ${product.name}: ${product.stock}`
        )
        .join("\n");


    return sendLongMessage(
      chatId,

`${title}

${
  text ||
  "Nothing here."
}`
    );
  }


  /* =======================================================
     CUSTOMER PROFILE
     ======================================================= */

  async function showCustomer(
    chatId,
    search
  ) {

    const needle =
      String(
        search ||
        ""
      )
        .replace(
          /^@/,
          ""
        )
        .trim()
        .toLowerCase();


    const matches =
      getSortedOrders()
        .filter(
          order =>

            String(
              order.telegramId ||
              ""
            ) ===
              needle ||

            normaliseUsername(
              order.telegramUsername
            ) ===
              needle ||

            String(
              order.customerName ||
              ""
            )
              .toLowerCase()
              .includes(
                needle
              )
        );


    if (
      !matches.length
    ) {

      return safeSendMessage(
        chatId,
        "❌ No customer found."
      );
    }


    const paid =
      matches.filter(
        order =>
          order.paymentStatus ===
          "paid"
      );


    const lifetime =
      paid.reduce(
        (
          total,
          order
        ) =>
          total +
          Number(
            order.totalPence ||
            0
          ),

        0
      );


    const recent =
      matches
        .slice(
          0,
          10
        )
        .map(
          order =>
            `#${order.orderId} • ${getOrderStatusText(
              order
            )} • ${money(
              order.totalPence
            )}`
        )
        .join("\n");


    return safeSendMessage(
      chatId,

`👤 CUSTOMER PROFILE

Name:
${matches[0].customerName}

Telegram:
${
  matches[0].telegramUsername
    ? `@${normaliseUsername(
        matches[0].telegramUsername
      )}`
    : (
        matches[0].telegramId ||
        "Not supplied"
      )
}

Orders:
${matches.length}

Paid orders:
${paid.length}

Lifetime spend:
${money(
  lifetime
)}

RECENT ORDERS

${recent}`
    );
  }


  /* =======================================================
     ACTIVITY LOG
     ======================================================= */

  async function showActivityLog(
    chatId
  ) {

    const rows =
      db
        .prepare(`
          SELECT *
          FROM activity_log
          ORDER BY id DESC
          LIMIT 40
        `)
        .all();


    const text =
      rows
        .map(
          row => {

            const when =
              new Date(
                row.created_at
              )
                .toLocaleString(
                  "en-GB"
                );


            return (
              `• ${when}\n` +
              `Admin: ${row.admin_id || "system"}\n` +
              `${row.action}` +
              (
                row.details
                  ? ` — ${row.details}`
                  : ""
              )
            );
          }
        )
        .join(
          "\n\n"
        );


    return sendLongMessage(
      chatId,

`📜 ADMIN ACTIVITY

${
  text ||
  "Nothing recorded yet."
}`
    );
  }


  /* =======================================================
     TIMELINE
     ======================================================= */

  async function showTimeline(
    chatId,
    order
  ) {

    ensureTimeline(
      order
    );


    const text =
      order.timeline
        .map(
          entry => {

            const when =
              new Date(
                entry.createdAt
              )
                .toLocaleString(
                  "en-GB"
                );


            return (
              `• ${when}\n` +
              `${entry.status}\n` +
              `By: ${entry.by}` +
              (
                entry.details
                  ? `\n${entry.details}`
                  : ""
              )
            );
          }
        )
        .join(
          "\n\n"
        );


    return sendLongMessage(
      chatId,

`🕒 ORDER #${order.orderId}

${
  text ||
  "No timeline entries."
}`
    );
  }


  /* =======================================================
     SETTINGS
     ======================================================= */

  async function showSettings(
    chatId
  ) {

    const settings =
      getShopSettings();


    return safeSendMessage(
      chatId,

`⚙️ SHOP SETTINGS

Checkout:
${
  settings.acceptingOrders
    ? "🟢 Accepting orders"
    : "🔴 Paused"
}

Minimum basket:
${money(
  settings.minimumOrderPence
)}

Shipping:
${money(
  settings.shippingPence
)}

Low-stock alert:
${settings.lowStockThreshold}`,

      {

        reply_markup: {

          inline_keyboard: [

            [
              {
                text:
                  settings.acceptingOrders
                    ? "⏸ Pause Checkout"
                    : "▶️ Resume Checkout",

                callback_data:
                  "admin_toggle_orders"
              }
            ],

            [
              {
                text:
                  "💷 Minimum Order",

                callback_data:
                  "admin_set_minimum"
              },

              {
                text:
                  "🚚 Delivery Charge",

                callback_data:
                  "admin_set_shipping"
              }
            ],

            [
              {
                text:
                  "📉 Low Stock Level",

                callback_data:
                  "admin_set_lowstock"
              }
            ],

            [
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


  /* =======================================================
     DISCOUNTS
     ======================================================= */

  async function showDiscounts(
    chatId
  ) {

    const lines =
      [
        ...discountCodes.values()
      ]
        .sort(
          (
            a,
            b
          ) =>
            String(
              a.code
            )
              .localeCompare(
                String(
                  b.code
                )
              )
        )
        .map(
          code => {

            const value =
              code.discountType ===
              "percent"
                ? `${code.discountValue}%`
                : money(
                    code.discountValue
                  );


            return (
              `• ${code.code} — ${value} — ` +
              (
                code.active ===
                  false
                  ? "Disabled"
                  : "Active"
              ) +
              (
                code.referralOwner
                  ? ` — ${code.referralOwner}`
                  : ""
              )
            );
          }
        )
        .join("\n");


    return safeSendMessage(
      chatId,

`🎟 DISCOUNT CODES

${lines || "No discount codes."}`,

      {

        reply_markup: {

          inline_keyboard: [

            [
              {
                text:
                  "➕ Create Code",

                callback_data:
                  "admin_discount_create"
              },

              {
                text:
                  "🚫 Disable Code",

                callback_data:
                  "admin_discount_disable"
              }
            ],

            [
              {
                text:
                  "✅ Enable Code",

                callback_data:
                  "admin_discount_enable"
              }
            ],

            [
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


  /* =======================================================
     ADMIN MANAGEMENT
     ======================================================= */

  async function showAdmins(
    chatId,
    viewerId
  ) {

    const admins =
      getAdmins();


    const lines =
      admins
        .map(
          admin =>
            `• ${admin.telegram_id} — ${admin.role}`
        )
        .join("\n");


    const buttons =
      [];


    if (
      isOwner(
        viewerId
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


    buttons.push([
      {
        text:
          "⬅️ Dashboard",

        callback_data:
          "admin_dashboard"
      }
    ]);


    return safeSendMessage(
      chatId,

`👮 ADMIN ACCOUNTS

${lines}

${
  isOwner(
    viewerId
  )
    ? "Owner controls enabled."
    : "Only the owner can add or remove admins."
}`,

      {

        reply_markup: {

          inline_keyboard:
            buttons
        }
      }
    );
  }


  /* =======================================================
     REVIEWS
     ======================================================= */

  async function showPendingReviews(
    chatId
  ) {

    const reviews =
      db
        .prepare(`
          SELECT *
          FROM reviews
          WHERE approved = 0
          ORDER BY id ASC
          LIMIT 20
        `)
        .all();


    if (
      !reviews.length
    ) {

      return safeSendMessage(
        chatId,
        "⭐ No reviews are waiting."
      );
    }


    for (
      const review
      of reviews
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


  /* =======================================================
     ADMIN COMMANDS
     ======================================================= */

  async function setCommandsForAdmin(
    adminId
  ) {

    try {

      await bot.setMyCommands(

        [
          {
            command:
              "admin",

            description:
              "Admin dashboard"
          },

          {
            command:
              "order",

            description:
              "Find order"
          },

          {
            command:
              "summary",

            description:
              "7 day report"
          },

          {
            command:
              "lowstock",

            description:
              "Low stock"
          },

          {
            command:
              "reviews",

            description:
              "Pending reviews"
          },

          {
            command:
              "earnings",

            description:
              "Affiliate earnings"
          },

          {
            command:
              "paid",

            description:
              "Mark order paid"
          },

          {
            command:
              "tracking",

            description:
              "Add tracking"
          },

          {
            command:
              "start",

            description:
              "Main menu"
          },

          {
            command:
              "myid",

            description:
              "Show Telegram ID"
          }
        ],

        {

          scope: {

            type:
              "chat",

            chat_id:
              Number(
                adminId
              )
          }
        }
      );

    } catch (err) {

      console.error(
        "SET ADMIN COMMANDS ERROR:",
        err?.message ||
        err
      );
    }
  }


  async function resetCommandsForUser(
    userId
  ) {

    try {

      await bot.setMyCommands(

        [
          {
            command:
              "start",

            description:
              "Open main menu"
          },

          {
            command:
              "myid",

            description:
              "Show Telegram ID"
          }
        ],

        {

          scope: {

            type:
              "chat",

            chat_id:
              Number(
                userId
              )
          }
        }
      );

    } catch {}
  }


  try {

    await bot.setMyCommands(
      [
        {
          command:
            "start",

          description:
            "Open main menu"
        },

        {
          command:
            "myid",

          description:
            "Show Telegram ID"
        }
      ]
    );


    for (
      const admin
      of getAdmins()
    ) {

      await setCommandsForAdmin(
        admin.telegram_id
      );
    }

  } catch (err) {

    console.error(
      "SET COMMANDS ERROR:",
      err?.message ||
      err
    );
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

`⚡️ Welcome

Use the menu below.`,

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

      return safeSendMessage(
        msg.chat.id,

        `Your Telegram ID: ${msg.from.id}`
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
     /ORDER
     ======================================================= */

  bot.onText(
    /^\/order(?:@\w+)?(?:\s+(\d+))?$/i,

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


      if (
        !match?.[1]
      ) {

        clearAdminInputs(
          msg.chat.id
        );


        pendingOrderSearch.add(
          msg.chat.id
        );


        return safeSendMessage(
          msg.chat.id,

`🔎 Send an order number, customer name, Telegram username, transaction hash or tracking number.`
        );
      }


      const order =
        orders.get(
          Number(
            match[1]
          )
        );


      if (
        !order
      ) {

        return safeSendMessage(
          msg.chat.id,
          "Order not found."
        );
      }


      return showAdminOrder(
        msg.chat.id,
        order
      );
    }
  );


  /* =======================================================
     /PAID
     ======================================================= */

  bot.onText(
    /^\/paid(?:@\w+)?(?:\s+(\d+))?$/i,

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


      if (
        !match?.[1]
      ) {

        return safeSendMessage(
          msg.chat.id,

`Use:

/paid ORDER_NUMBER

Example:
/paid 1030`
        );
      }


      const order =
        orders.get(
          Number(
            match[1]
          )
        );


      if (
        !order
      ) {

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


      if (
        !result.ok
      ) {

        return safeSendMessage(
          msg.chat.id,
          `❌ ${result.error}`
        );
      }


      return safeSendMessage(
        msg.chat.id,

        result.alreadyPaid
          ? `Order #${order.orderId} was already paid.`
          : `✅ Order #${order.orderId} marked paid and moved into packing.`
      );
    }
  );


  /* =======================================================
     /TRACKING
     ======================================================= */

  bot.onText(
    /^\/tracking(?:@\w+)?(?:\s+(\d+)\s+(.+))?$/i,

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


      if (
        !match?.[1] ||
        !match?.[2]
      ) {

        return safeSendMessage(
          msg.chat.id,

`Use:

/tracking ORDER_NUMBER TRACKING_NUMBER`
        );
      }


      const order =
        orders.get(
          Number(
            match[1]
          )
        );


      if (
        !order ||
        order.paymentStatus !==
          "paid"
      ) {

        return safeSendMessage(
          msg.chat.id,
          "Paid order not found."
        );
      }


      order.trackingNumber =
        String(
          match[2]
        )
          .trim();


      order.fulfilmentStatus =
        "shipped";


      order.shippedAt =
        new Date()
          .toISOString();


      addTimeline(
        order,
        "shipped",
        msg.from.id,
        order.trackingNumber
      );


      saveOrder(
        order
      );


      logActivity(
        msg.from.id,
        "DISPATCH_ORDER",
        `Order #${order.orderId} • ${order.trackingNumber}`
      );


      if (
        order.telegramId
      ) {

        await safeSendMessage(
          order.telegramId,

`📦 Your order has been dispatched

Order:
#${order.orderId}

Tracking:
${order.trackingNumber}`
        );
      }


      return safeSendMessage(
        msg.chat.id,
        "✅ Tracking saved."
      );
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
        "7 DAY REPORT"
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
        getShopSettings()
          .lowStockThreshold;


      const list =
        getLiveProducts()
          .filter(
            product =>
              Number(
                product.stock
              ) <=
                threshold
          );


      return sendStockList(
        msg.chat.id,
        "📉 LOW STOCK",
        list
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


      return showPendingReviews(
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


      return sendLongMessage(
        msg.chat.id,
        getAffiliateEarningsText()
      );
    }
  );


  /* =======================================================
     CALLBACK QUERIES
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


      /* =====================================================
         REVIEW APPROVE
         ===================================================== */

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
          db
            .prepare(`
              SELECT *
              FROM reviews
              WHERE id = ?
            `)
            .get(
              reviewId
            );


        if (
          !review
        ) {

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
          q.from.id,
          "APPROVE_REVIEW",
          `Review #${reviewId}`
        );


        return safeSendMessage(
          chatId,
          `✅ Review #${reviewId} approved.`
        );
      }


      /* =====================================================
         REVIEW REJECT
         ===================================================== */

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


        db
          .prepare(`
            DELETE FROM reviews
            WHERE id = ?
          `)
          .run(
            reviewId
          );


        logActivity(
          q.from.id,
          "REJECT_REVIEW",
          `Review #${reviewId}`
        );


        return safeSendMessage(
          chatId,
          `❌ Review #${reviewId} rejected.`
        );
      }


      /* =====================================================
         CUSTOMER CANCEL CONFIRM
         MUST BE BEFORE customer_cancel_
         ===================================================== */

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
          !orderBelongsToViewer(
            order,
            {

              telegramId:
                q.from?.id,

              telegramUsername:
                q.from?.username
            }
          )
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
            "This order can no longer be cancelled automatically."
          );
        }


        const restored =
          restoreStoreCreditForOrder(
            order
          );


        order.paymentStatus =
          "cancelled";


        order.fulfilmentStatus =
          "cancelled";


        order.cancelledAt =
          new Date()
            .toISOString();


        order.cancelledBy =
          `customer:${q.from?.id}`;


        addTimeline(
          order,
          "cancelled",
          `customer:${q.from?.id}`,
          "Customer cancelled order"
        );


        saveOrder(
          order
        );


        await sendToAdmins(

`❌ CUSTOMER CANCELLED ORDER

Order:
#${order.orderId}

Customer:
${order.customerName}

${
  restored
    ? `Store credit restored:
${money(
  order.storeCreditPence
)}`
    : ""
}`
        );


        return safeSendMessage(
          chatId,

`❌ Order #${orderId} cancelled.${
  restored
    ? `

Store credit restored:
${money(
  order.storeCreditPence
)}`
    : ""
}`
        );
      }


      /* =====================================================
         CUSTOMER CANCEL
         ===================================================== */

      if (
        data.startsWith(
          "customer_cancel_"
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
          !orderBelongsToViewer(
            order,
            {

              telegramId:
                q.from?.id,

              telegramUsername:
                q.from?.username
            }
          )
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
            "Only orders awaiting payment can be cancelled."
          );
        }


        return safeSendMessage(
          chatId,

`Cancel order #${orderId}?`,

          {

            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "❌ Yes, Cancel",

                    callback_data:
                      `customer_cancel_confirm_${orderId}`
                  },

                  {
                    text:
                      "Keep Order",

                    callback_data:
                      "orders"
                  }
                ]
              ]
            }
          }
        );
      }


      /* =====================================================
         ADMIN ACCESS CHECK
         ===================================================== */

      if (
        data.startsWith(
          "admin_"
        ) &&
        !isAdmin(
          q.from?.id
        )
      ) {

        return safeSendMessage(
          chatId,
          "Admin only."
        );
      }


      /* =====================================================
         DASHBOARD
         ===================================================== */

      if (
        data ===
        "admin_dashboard"
      ) {

        return sendAdminDashboard(
          chatId
        );
      }


      /* =====================================================
         ORDER QUEUES
         ===================================================== */

      if (
        data ===
        "admin_recent"
      ) {

        return showOrderList(
          chatId,
          "📦 RECENT ORDERS",
          getSortedOrders()
            .slice(
              0,
              20
            )
        );
      }


      if (
        data ===
        "admin_payments"
      ) {

        return showOrderList(
          chatId,
          "⏳ PAYMENT SUBMITTED",
          getSortedOrders()
            .filter(
              order =>
                order.paymentStatus ===
                "payment_submitted"
            )
        );
      }


      if (
        data ===
        "admin_packing"
      ) {

        return showOrderList(
          chatId,
          "🧺 PACKING QUEUE",
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "needs_packing"
            )
        );
      }


      if (
        data ===
        "admin_dispatch"
      ) {

        return showOrderList(
          chatId,
          "🚚 DISPATCH QUEUE",
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "packed"
            )
        );
      }


      if (
        data ===
        "admin_completed"
      ) {

        return showOrderList(
          chatId,
          "✅ COMPLETED ORDERS",
          getSortedOrders()
            .filter(
              order =>
                order.fulfilmentStatus ===
                "completed"
            )
        );
      }


      if (
        data ===
        "admin_cancelled"
      ) {

        return showOrderList(
          chatId,
          "❌ CANCELLED ORDERS",
          getSortedOrders()
            .filter(
              order =>
                order.paymentStatus ===
                "cancelled"
            )
        );
      }


      /* =====================================================
         FIND ORDER
         ===================================================== */

      if (
        data ===
        "admin_find_order"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingOrderSearch.add(
          chatId
        );


        return safeSendMessage(
          chatId,

`🔎 FIND ORDER

Send:

• Order number
• Customer name
• Telegram username
• Tracking number
• Transaction hash`
        );
      }


      /* =====================================================
         FIND CUSTOMER
         ===================================================== */

      if (
        data ===
        "admin_find_customer"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingCustomerSearch.add(
          chatId
        );


        return safeSendMessage(
          chatId,

`👤 FIND CUSTOMER

Send:

• Telegram username
• Telegram ID
• Customer name`
        );
      }


      /* =====================================================
         REPORTS
         ===================================================== */

      if (
        data ===
        "admin_reports"
      ) {

        return safeSendMessage(
          chatId,
          "📊 SALES REPORTS",

          {

            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "24 Hours",

                    callback_data:
                      "admin_report_1"
                  },

                  {
                    text:
                      "7 Days",

                    callback_data:
                      "admin_report_7"
                  }
                ],

                [
                  {
                    text:
                      "30 Days",

                    callback_data:
                      "admin_report_30"
                  },

                  {
                    text:
                      "All Time",

                    callback_data:
                      "admin_report_all"
                  }
                ],

                [
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


      if (
        data ===
        "admin_report_1"
      ) {

        return sendSalesReport(
          chatId,
          1,
          "LAST 24 HOURS"
        );
      }


      if (
        data ===
        "admin_report_7"
      ) {

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

        return sendSalesReport(
          chatId,
          30,
          "30 DAY REPORT"
        );
      }


      if (
        data ===
        "admin_report_all"
      ) {

        return sendSalesReport(
          chatId,
          null,
          "ALL TIME REPORT"
        );
      }


      /* =====================================================
         STOCK
         ===================================================== */

      if (
        data ===
        "admin_stock"
      ) {

        return showStockCentre(
          chatId
        );
      }


      if (
        data ===
        "admin_stock_all"
      ) {

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

        const threshold =
          getShopSettings()
            .lowStockThreshold;


        return sendStockList(
          chatId,
          "📉 LOW STOCK",
          getLiveProducts()
            .filter(
              product =>
                Number(
                  product.stock
                ) >
                  0 &&
                Number(
                  product.stock
                ) <=
                  threshold
            )
        );
      }


      if (
        data ===
        "admin_stock_out"
      ) {

        return sendStockList(
          chatId,
          "❌ OUT OF STOCK",
          getLiveProducts()
            .filter(
              product =>
                Number(
                  product.stock
                ) ===
                  0
            )
        );
      }


      if (
        data ===
        "admin_stock_adjust"
      ) {

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

`✏️ CHANGE STOCK

Send the product ID.`
        );
      }


      /* =====================================================
         REVIEWS
         ===================================================== */

      if (
        data ===
        "admin_reviews"
      ) {

        return showPendingReviews(
          chatId
        );
      }


      /* =====================================================
         DISCOUNTS
         ===================================================== */

      if (
        data ===
        "admin_discounts"
      ) {

        return showDiscounts(
          chatId
        );
      }


      if (
        data ===
        "admin_discount_create"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingDiscountCreation.set(
          chatId,
          {

            stage:
              "code"
          }
        );


        return safeSendMessage(
          chatId,

`🎟 CREATE DISCOUNT

Send the code name.

Example:
WELCOME10`
        );
      }


      if (
        data ===
        "admin_discount_disable"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingDiscountCreation.set(
          chatId,
          {

            stage:
              "disable"
          }
        );


        return safeSendMessage(
          chatId,
          "Send the code to disable."
        );
      }


      if (
        data ===
        "admin_discount_enable"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingDiscountCreation.set(
          chatId,
          {

            stage:
              "enable"
          }
        );


        return safeSendMessage(
          chatId,
          "Send the code to enable."
        );
      }


      /* =====================================================
         AFFILIATE EARNINGS
         ===================================================== */

      if (
        data ===
        "admin_earnings"
      ) {

        return sendLongMessage(
          chatId,
          getAffiliateEarningsText()
        );
      }


      /* =====================================================
         ANNOUNCEMENT
         ===================================================== */

      if (
        data ===
        "admin_announcement"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingAnnouncement.set(
          chatId,
          {

            stage:
              "message"
          }
        );


        return safeSendMessage(
          chatId,

`📢 CUSTOMER ANNOUNCEMENT

Send the announcement text.

You will be asked to confirm before it sends.`
        );
      }


      if (
        data ===
        "admin_announcement_confirm"
      ) {

        const state =
          pendingAnnouncement.get(
            chatId
          );


        if (
          !state?.message
        ) {

          return safeSendMessage(
            chatId,
            "No announcement is waiting."
          );
        }


        const customerIds =
          [
            ...new Set(
              getSortedOrders()
                .map(
                  order =>
                    String(
                      order.telegramId ||
                      ""
                    )
                )
                .filter(Boolean)
            )
          ];


        let sent =
          0;


        for (
          const customerId
          of customerIds
        ) {

          const result =
            await safeSendMessage(
              customerId,
              state.message
            );


          if (
            result
          ) {

            sent +=
              1;
          }
        }


        logActivity(
          q.from.id,
          "ANNOUNCEMENT",
          `Sent to ${sent} customers`
        );


        pendingAnnouncement.delete(
          chatId
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

        pendingAnnouncement.delete(
          chatId
        );


        return safeSendMessage(
          chatId,
          "Announcement cancelled."
        );
      }


      /* =====================================================
         ACTIVITY
         ===================================================== */

      if (
        data ===
        "admin_activity"
      ) {

        return showActivityLog(
          chatId
        );
      }


      /* =====================================================
         EXPORT
         ===================================================== */

      if (
        data ===
        "admin_export"
      ) {

        return safeSendMessage(
          chatId,
          "📥 EXPORT DATA",

          {

            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "🧾 Orders CSV",

                    callback_data:
                      "admin_export_orders"
                  },

                  {
                    text:
                      "📦 Stock CSV",

                    callback_data:
                      "admin_export_stock"
                  }
                ],

                [
                  {
                    text:
                      "💰 Affiliates CSV",

                    callback_data:
                      "admin_export_affiliates"
                  }
                ],

                [
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


      if (
        data ===
        "admin_export_orders"
      ) {

        const buffer =
          Buffer.from(
            buildOrdersCsv(),
            "utf8"
          );


        await bot.sendDocument(
          chatId,
          buffer,
          {},
          {

            filename:
              `orders-${new Date()
                .toISOString()
                .slice(
                  0,
                  10
                )}.csv`,

            contentType:
              "text/csv"
          }
        );


        logActivity(
          q.from.id,
          "EXPORT_ORDERS",
          "Orders CSV"
        );


        return;
      }


      if (
        data ===
        "admin_export_stock"
      ) {

        const buffer =
          Buffer.from(
            buildInventoryCsv(),
            "utf8"
          );


        await bot.sendDocument(
          chatId,
          buffer,
          {},
          {

            filename:
              `stock-${new Date()
                .toISOString()
                .slice(
                  0,
                  10
                )}.csv`,

            contentType:
              "text/csv"
          }
        );


        logActivity(
          q.from.id,
          "EXPORT_STOCK",
          "Stock CSV"
        );


        return;
      }


      if (
        data ===
        "admin_export_affiliates"
      ) {

        const buffer =
          Buffer.from(
            buildAffiliateCsv(),
            "utf8"
          );


        await bot.sendDocument(
          chatId,
          buffer,
          {},
          {

            filename:
              `affiliate-earnings-${new Date()
                .toISOString()
                .slice(
                  0,
                  10
                )}.csv`,

            contentType:
              "text/csv"
          }
        );


        logActivity(
          q.from.id,
          "EXPORT_AFFILIATES",
          "Affiliate earnings CSV"
        );


        return;
      }


      /* =====================================================
         SETTINGS
         ===================================================== */

      if (
        data ===
        "admin_settings"
      ) {

        return showSettings(
          chatId
        );
      }


      if (
        data ===
        "admin_toggle_orders"
      ) {

        const settings =
          getShopSettings();


        const newValue =
          !settings.acceptingOrders;


        setMeta(
          "setting:acceptingOrders",
          newValue
        );


        logActivity(
          q.from.id,

          newValue
            ? "RESUME_CHECKOUT"
            : "PAUSE_CHECKOUT",

          ""
        );


        return showSettings(
          chatId
        );
      }


      if (
        data ===
        "admin_set_minimum"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingSettingChange.set(
          chatId,
          "minimum"
        );


        return safeSendMessage(
          chatId,

`💷 Send the new minimum order in pounds.

Example:
50`
        );
      }


      if (
        data ===
        "admin_set_shipping"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingSettingChange.set(
          chatId,
          "shipping"
        );


        return safeSendMessage(
          chatId,

`🚚 Send the new delivery charge in pounds.

Example:
5`
        );
      }


      if (
        data ===
        "admin_set_lowstock"
      ) {

        clearAdminInputs(
          chatId
        );


        pendingSettingChange.set(
          chatId,
          "lowstock"
        );


        return safeSendMessage(
          chatId,

`📉 Send the new low-stock alert level.

Example:
5`
        );
      }


      /* =====================================================
         ADMIN MANAGEMENT
         ===================================================== */

      if (
        data ===
        "admin_manage_admins"
      ) {

        return showAdmins(
          chatId,
          q.from?.id
        );
      }


      if (
        data ===
        "admin_add_admin"
      ) {

        if (
          !isOwner(
            q.from?.id
          )
        ) {

          return safeSendMessage(
            chatId,
            "Only the owner can add admins."
          );
        }


        clearAdminInputs(
          chatId
        );


        pendingAdminManagement.set(
          chatId,
          "add"
        );


        return safeSendMessage(
          chatId,

`➕ ADD ADMIN

Send their Telegram ID.

They can use /myid to find it.`
        );
      }


      if (
        data ===
        "admin_remove_admin"
      ) {

        if (
          !isOwner(
            q.from?.id
          )
        ) {

          return safeSendMessage(
            chatId,
            "Only the owner can remove admins."
          );
        }


        clearAdminInputs(
          chatId
        );


        pendingAdminManagement.set(
          chatId,
          "remove"
        );


        return safeSendMessage(
          chatId,

`➖ REMOVE ADMIN

Send their Telegram ID.`
        );
      }


      /* =====================================================
         ORDER DETAIL
         ===================================================== */

      if (
        data.startsWith(
          "admin_order_"
        )
      ) {

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


      /* =====================================================
         MARK PAID
         ===================================================== */

      if (
        data.startsWith(
          "admin_paid_"
        )
      ) {

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
            order,
            q.from.id
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
            ? `Order #${orderId} was already paid.`
            : `✅ Order #${orderId} marked paid.`
        );


        return showAdminOrder(
          chatId,
          order
        );
      }


      /* =====================================================
         PACK
         ===================================================== */

      if (
        data.startsWith(
          "admin_pack_"
        )
      ) {

        const orderId =
          Number(
            data.replace(
              "admin_pack_",
              ""
            )
          );


        const order =
          orders.get(
            orderId
          );


        if (
          !order ||
          order.fulfilmentStatus !==
          "needs_packing"
        ) {

          return safeSendMessage(
            chatId,
            "Order is not in the packing queue."
          );
        }


        order.fulfilmentStatus =
          "packed";


        order.packedAt =
          new Date()
            .toISOString();


        addTimeline(
          order,
          "packed",
          q.from.id,
          "Order packed"
        );


        saveOrder(
          order
        );


        logActivity(
          q.from.id,
          "PACK_ORDER",
          `Order #${orderId}`
        );


        await safeSendMessage(
          chatId,

`📦 Order #${orderId} packed.

It is now in the Dispatch Queue.`
        );


        return showAdminOrder(
          chatId,
          order
        );
      }


      /* =====================================================
         TRACKING
         ===================================================== */

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


        pendingTracking.set(
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


      /* =====================================================
         COMPLETE
         ===================================================== */

      if (
        data.startsWith(
          "admin_complete_"
        )
      ) {

        const orderId =
          Number(
            data.replace(
              "admin_complete_",
              ""
            )
          );


        const order =
          orders.get(
            orderId
          );


        if (
          !order ||
          order.fulfilmentStatus !==
          "shipped"
        ) {

          return safeSendMessage(
            chatId,
            "Dispatched order not found."
          );
        }


        order.fulfilmentStatus =
          "completed";


        order.completedAt =
          new Date()
            .toISOString();


        addTimeline(
          order,
          "completed",
          q.from.id,
          "Order completed"
        );


        saveOrder(
          order
        );


        logActivity(
          q.from.id,
          "COMPLETE_ORDER",
          `Order #${orderId}`
        );


        return showAdminOrder(
          chatId,
          order
        );
      }


      /* =====================================================
         TIMELINE
         ===================================================== */

      if (
        data.startsWith(
          "admin_timeline_"
        )
      ) {

        const orderId =
          Number(
            data.replace(
              "admin_timeline_",
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


        return showTimeline(
          chatId,
          order
        );
      }


      /* =====================================================
         NOTE
         ===================================================== */

      if (
        data.startsWith(
          "admin_note_"
        )
      ) {

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

`📝 Send the private note for order #${orderId}.`
        );
      }


      /* =====================================================
         REVIEW LINK
         ===================================================== */

      if (
        data.startsWith(
          "admin_review_"
        )
      ) {

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
            "paid" ||
          !order.telegramId
        ) {

          return safeSendMessage(
            chatId,
            "Paid Telegram order not found."
          );
        }


        const url =
          getReviewUrl(
            order
          );


        if (
          !url
        ) {

          return safeSendMessage(
            chatId,
            "Review link unavailable."
          );
        }


        await safeSendMessage(
          order.telegramId,

`⭐ We'd love your feedback

Order:
#${orderId}`,

          {

            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "⭐ Leave a Review",

                    url
                  }
                ]
              ]
            }
          }
        );


        logActivity(
          q.from.id,
          "SEND_REVIEW_LINK",
          `Order #${orderId}`
        );


        return safeSendMessage(
          chatId,
          "✅ Review link sent."
        );
      }


      /* =====================================================
         ADMIN CANCEL CONFIRM
         MUST BE BEFORE admin_cancel_
         ===================================================== */

      if (
        data.startsWith(
          "admin_cancel_confirm_"
        )
      ) {

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


        if (
          order.paymentStatus !==
          "awaiting_payment"
        ) {

          return safeSendMessage(
            chatId,
            "Only orders awaiting payment can be cancelled."
          );
        }


        const restored =
          restoreStoreCreditForOrder(
            order
          );


        order.paymentStatus =
          "cancelled";


        order.fulfilmentStatus =
          "cancelled";


        order.cancelledAt =
          new Date()
            .toISOString();


        order.cancelledBy =
          String(
            q.from.id
          );


        addTimeline(
          order,
          "cancelled",
          q.from.id,
          "Cancelled by admin"
        );


        saveOrder(
          order
        );


        logActivity(
          q.from.id,
          "CANCEL_ORDER",
          `Order #${orderId}`
        );


        if (
          order.telegramId
        ) {

          await safeSendMessage(
            order.telegramId,

`❌ Order #${orderId} has been cancelled.${
  restored
    ? `

Store credit restored:
${money(
  order.storeCreditPence
)}`
    : ""
}`
          );
        }


        return showAdminOrder(
          chatId,
          order
        );
      }


      /* =====================================================
         ADMIN CANCEL
         ===================================================== */

      if (
        data.startsWith(
          "admin_cancel_"
        )
      ) {

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
            "Only orders awaiting payment can be cancelled."
          );
        }


        return safeSendMessage(
          chatId,

`⚠️ Cancel order #${orderId}?`,

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


      /* =====================================================
         DELETE CONFIRM
         MUST BE BEFORE admin_delete_
         ===================================================== */

      if (
        data.startsWith(
          "admin_delete_confirm_"
        )
      ) {

        const orderId =
          Number(
            data.replace(
              "admin_delete_confirm_",
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
          "cancelled"
        ) {

          return safeSendMessage(
            chatId,
            "Only cancelled orders can be permanently deleted."
          );
        }


        deleteOrder(
          orderId
        );


        logActivity(
          q.from.id,
          "DELETE_ORDER",
          `Order #${orderId}`
        );


        return safeSendMessage(
          chatId,

`🗑 Order #${orderId} permanently deleted.`
        );
      }


      /* =====================================================
         DELETE
         ===================================================== */

      if (
        data.startsWith(
          "admin_delete_"
        )
      ) {

        const orderId =
          Number(
            data.replace(
              "admin_delete_",
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
            "cancelled"
        ) {

          return safeSendMessage(
            chatId,
            "Only cancelled orders can be deleted."
          );
        }


        return safeSendMessage(
          chatId,

`⚠️ PERMANENTLY DELETE ORDER #${orderId}?

This cannot be undone.`,

          {

            reply_markup: {

              inline_keyboard: [

                [
                  {
                    text:
                      "🗑 Yes, Delete",

                    callback_data:
                      `admin_delete_confirm_${orderId}`
                  },

                  {
                    text:
                      "Keep Record",

                    callback_data:
                      `admin_order_${orderId}`
                  }
                ]
              ]
            }
          }
        );
      }


      /* =====================================================
         MY ORDERS
         ===================================================== */

      if (
        data ===
        "orders"
      ) {

        const matches =
          getSortedOrders()
            .filter(
              order =>
                orderBelongsToViewer(
                  order,
                  {

                    telegramId:
                      q.from?.id,

                    telegramUsername:
                      q.from?.username
                  }
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


        await safeSendMessage(
          chatId,
          "📦 My Orders"
        );


        for (
          const order
          of matches
        ) {

          const buttons =
            [];


          if (
            order.paymentStatus ===
            "awaiting_payment"
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

`#${order.orderId}

${money(
  order.totalPence
)}

${getOrderStatusText(
  order
)}${
  order.trackingNumber
    ? `

Tracking:
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


        return;
      }


      /* =====================================================
         SUPPORT
         ===================================================== */

      if (
        data ===
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

Send your message below.`
        );
      }


      /* =====================================================
         INFO
         ===================================================== */

      if (
        data ===
        "info"
      ) {

        const settings =
          getShopSettings();


        return safeSendMessage(
          chatId,

`ℹ️ Info

Minimum basket:
${money(
  settings.minimumOrderPence
)}

Delivery:
${money(
  settings.shippingPence
)}

Checkout:
${
  settings.acceptingOrders
    ? "Open"
    : "Temporarily paused"
}`
        );
      }
    }
  );


  /* =======================================================
     MESSAGE INPUTS
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
        )
          .trim();


      /* =====================================================
         FIND ORDER
         ===================================================== */

      if (
        pendingOrderSearch.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        pendingOrderSearch.delete(
          chatId
        );


        const needle =
          text
            .replace(
              /^#/,
              ""
            )
            .trim()
            .toLowerCase();


        const matches =
          getSortedOrders()
            .filter(
              order =>

                String(
                  order.orderId
                ) ===
                  needle ||

                String(
                  order.customerName ||
                  ""
                )
                  .toLowerCase()
                  .includes(
                    needle
                  ) ||

                normaliseUsername(
                  order.telegramUsername
                )
                  .includes(
                    needle.replace(
                      /^@/,
                      ""
                    )
                  ) ||

                String(
                  order.trackingNumber ||
                  ""
                )
                  .toLowerCase()
                  .includes(
                    needle
                  ) ||

                String(
                  order.transactionId ||
                  ""
                )
                  .toLowerCase() ===
                  needle
            );


        if (
          !matches.length
        ) {

          return safeSendMessage(
            chatId,
            "❌ No matching orders."
          );
        }


        if (
          matches.length ===
          1
        ) {

          return showAdminOrder(
            chatId,
            matches[0]
          );
        }


        return showOrderList(
          chatId,
          "🔎 SEARCH RESULTS",
          matches
        );
      }


      /* =====================================================
         FIND CUSTOMER
         ===================================================== */

      if (
        pendingCustomerSearch.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        pendingCustomerSearch.delete(
          chatId
        );


        return showCustomer(
          chatId,
          text
        );
      }


      /* =====================================================
         TRACKING INPUT
         ===================================================== */

      if (
        pendingTracking.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const orderId =
          pendingTracking.get(
            chatId
          );


        pendingTracking.delete(
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


        addTimeline(
          order,
          "shipped",
          msg.from.id,
          text
        );


        saveOrder(
          order
        );


        logActivity(
          msg.from.id,
          "DISPATCH_ORDER",
          `Order #${orderId} • ${text}`
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


        return safeSendMessage(
          chatId,

`✅ Order #${orderId} dispatched.

Tracking:
${text}`
        );
      }


      /* =====================================================
         NOTE INPUT
         ===================================================== */

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

          return safeSendMessage(
            chatId,
            "Order not found."
          );
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

          adminTelegramId:
            String(
              msg.from.id
            )
        });


        saveOrder(
          order
        );


        logActivity(
          msg.from.id,
          "ADD_NOTE",
          `Order #${orderId}`
        );


        return showAdminOrder(
          chatId,
          order
        );
      }


      /* =====================================================
         STOCK INPUT
         ===================================================== */

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
              "❌ Product not found."
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

`✏️ ${product.name}

Current stock:
${getLiveStock(
  productId
)}

Send the NEW total stock number.`
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


          logActivity(
            msg.from.id,

            "ADJUST_STOCK",

            `${product?.name || state.productId}: ${oldStock} → ${newStock}`
          );


          await alertStockChange(

            product ||
            {

              id:
                state.productId,

              name:
                "Product"
            },

            oldStock,

            newStock
          );


          return safeSendMessage(
            chatId,

`✅ STOCK UPDATED

${product?.name || `Product #${state.productId}`}

${oldStock} → ${newStock}`
          );
        }
      }


      /* =====================================================
         SETTINGS INPUT
         ===================================================== */

      if (
        pendingSettingChange.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const setting =
          pendingSettingChange.get(
            chatId
          );


        pendingSettingChange.delete(
          chatId
        );


        if (
          setting ===
            "minimum" ||
          setting ===
            "shipping"
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
              "❌ Enter a valid amount in pounds."
            );
          }


          const pence =
            Math.round(
              pounds *
              100
            );


          const key =
            setting ===
              "minimum"
              ? "minimumOrderPence"
              : "shippingPence";


          setMeta(
            `setting:${key}`,
            pence
          );


          logActivity(
            msg.from.id,
            "CHANGE_SETTING",
            `${key} = ${pence}`
          );


          return showSettings(
            chatId
          );
        }


        if (
          setting ===
          "lowstock"
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
              "❌ Enter a whole number of 0 or more."
            );
          }


          setMeta(
            "setting:lowStockThreshold",
            threshold
          );


          logActivity(
            msg.from.id,
            "CHANGE_SETTING",
            `lowStockThreshold = ${threshold}`
          );


          return showSettings(
            chatId
          );
        }
      }


      /* =====================================================
         DISCOUNT INPUT
         ===================================================== */

      if (
        pendingDiscountCreation.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const state =
          pendingDiscountCreation.get(
            chatId
          );


        if (
          state.stage ===
          "disable"
        ) {

          const code =
            normaliseCode(
              text
            );


          const record =
            discountCodes.get(
              code
            );


          if (
            !record
          ) {

            pendingDiscountCreation.delete(
              chatId
            );


            return safeSendMessage(
              chatId,
              "❌ Code not found."
            );
          }


          if (
            record.protected
          ) {

            pendingDiscountCreation.delete(
              chatId
            );


            return safeSendMessage(
              chatId,
              "That affiliate code is protected and cannot be disabled here."
            );
          }


          record.active =
            false;


          saveDiscountCode(
            code,
            record
          );


          pendingDiscountCreation.delete(
            chatId
          );


          logActivity(
            msg.from.id,
            "DISABLE_DISCOUNT",
            code
          );


          return showDiscounts(
            chatId
          );
        }


        if (
          state.stage ===
          "enable"
        ) {

          const code =
            normaliseCode(
              text
            );


          const record =
            discountCodes.get(
              code
            );


          if (
            !record
          ) {

            pendingDiscountCreation.delete(
              chatId
            );


            return safeSendMessage(
              chatId,
              "❌ Code not found."
            );
          }


          record.active =
            true;


          saveDiscountCode(
            code,
            record
          );


          pendingDiscountCreation.delete(
            chatId
          );


          logActivity(
            msg.from.id,
            "ENABLE_DISCOUNT",
            code
          );


          return showDiscounts(
            chatId
          );
        }


        if (
          state.stage ===
          "code"
        ) {

          const code =
            normaliseCode(
              text
            );


          if (
            !/^[A-Z0-9_-]{2,30}$/.test(
              code
            )
          ) {

            return safeSendMessage(
              chatId,

`❌ Invalid code.

Use letters, numbers, - or _.`
            );
          }


          if (
            discountCodes.has(
              code
            )
          ) {

            return safeSendMessage(
              chatId,
              "❌ That discount code already exists."
            );
          }


          state.code =
            code;


          state.stage =
            "type";


          pendingDiscountCreation.set(
            chatId,
            state
          );


          return safeSendMessage(
            chatId,

`Code:
${code}

Reply with:

percent

or

fixed`
          );
        }


        if (
          state.stage ===
          "type"
        ) {

          const type =
            text
              .trim()
              .toLowerCase();


          if (
            ![
              "percent",
              "fixed"
            ].includes(
              type
            )
          ) {

            return safeSendMessage(
              chatId,
              "Reply with percent or fixed."
            );
          }


          state.type =
            type;


          state.stage =
            "value";


          pendingDiscountCreation.set(
            chatId,
            state
          );


          return safeSendMessage(
            chatId,

            type ===
              "percent"
              ? `Send the percentage.

Example:
10`
              : `Send the fixed discount in pounds.

Example:
5`
          );
        }


        if (
          state.stage ===
          "value"
        ) {

          const value =
            Number(
              text
            );


          if (
            !Number.isFinite(
              value
            ) ||
            value <=
              0
          ) {

            return safeSendMessage(
              chatId,
              "❌ Enter a valid value."
            );
          }


          if (
            state.type ===
              "percent" &&
            value >
              100
          ) {

            return safeSendMessage(
              chatId,
              "Percentage cannot be over 100."
            );
          }


          const discountValue =
            state.type ===
              "percent"
              ? value
              : Math.round(
                  value *
                  100
                );


          saveDiscountCode(
            state.code,
            {

              code:
                state.code,

              discountType:
                state.type,

              discountValue,

              active:
                true,

              protected:
                false,

              createdAt:
                new Date()
                  .toISOString(),

              createdBy:
                String(
                  msg.from.id
                )
            }
          );


          logActivity(
            msg.from.id,
            "CREATE_DISCOUNT",
            state.code
          );


          pendingDiscountCreation.delete(
            chatId
          );


          return showDiscounts(
            chatId
          );
        }
      }


      /* =====================================================
         ADMIN MANAGEMENT INPUT
         ===================================================== */

      if (
        pendingAdminManagement.has(
          chatId
        ) &&
        isOwner(
          msg.from?.id
        )
      ) {

        const action =
          pendingAdminManagement.get(
            chatId
          );


        pendingAdminManagement.delete(
          chatId
        );


        const telegramId =
          String(
            text
          )
            .trim();


        if (
          !/^\d+$/.test(
            telegramId
          )
        ) {

          return safeSendMessage(
            chatId,
            "❌ Invalid Telegram ID."
          );
        }


        if (
          action ===
          "add"
        ) {

          addAdmin(
            telegramId,
            msg.from.id
          );


          await setCommandsForAdmin(
            telegramId
          );


          logActivity(
            msg.from.id,
            "ADD_ADMIN",
            telegramId
          );


          await safeSendMessage(
            telegramId,

`👮 You have been added as an admin.

Use /admin to open the admin dashboard.`
          );


          return showAdmins(
            chatId,
            msg.from.id
          );
        }


        if (
          action ===
          "remove"
        ) {

          if (
            telegramId ===
            ownerTelegramId
          ) {

            return safeSendMessage(
              chatId,
              "❌ The owner cannot be removed."
            );
          }


          removeAdmin(
            telegramId
          );


          await resetCommandsForUser(
            telegramId
          );


          logActivity(
            msg.from.id,
            "REMOVE_ADMIN",
            telegramId
          );


          return showAdmins(
            chatId,
            msg.from.id
          );
        }
      }


      /* =====================================================
         ANNOUNCEMENT INPUT
         ===================================================== */

      if (
        pendingAnnouncement.has(
          chatId
        ) &&
        isAdmin(
          msg.from?.id
        )
      ) {

        const state =
          pendingAnnouncement.get(
            chatId
          );


        if (
          state.stage ===
          "message"
        ) {

          state.message =
            text.slice(
              0,
              3000
            );


          state.stage =
            "confirm";


          pendingAnnouncement.set(
            chatId,
            state
          );


          return safeSendMessage(
            chatId,

`📢 ANNOUNCEMENT PREVIEW

${state.message}

Send this to customers?`,

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
      }


      /* =====================================================
         SUPPORT
         ===================================================== */

      if (
        pendingSupport.has(
          chatId
        )
      ) {

        pendingSupport.delete(
          chatId
        );


        const from =
          msg.from?.username
            ? `@${msg.from.username}`
            : `Telegram ID ${msg.from?.id}`;


        for (
          const supportId
          of supportTelegramIds
        ) {

          await safeSendMessage(
            supportId,

`💬 New Support Message

From:
${from}

Message:
${text}`
          );
        }


        return safeSendMessage(
          chatId,
          "Thanks — your message has been sent."
        );
      }
    }
  );
}


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

    const settings =
      getShopSettings();


    console.log(
      `Storefront running on port ${port}`
    );


    console.log(
      `Products: ${products.length}`
    );


    console.log(
      `Admins: ${getAdmins().length}`
    );


    console.log(
      `Affiliates: ${affiliateCodes.length}`
    );


    console.log(
      `Owner configured: ${Boolean(
        ownerTelegramId
      )}`
    );


    console.log(
      `Checkout: ${
        settings.acceptingOrders
          ? "OPEN"
          : "PAUSED"
      }`
    );


    console.log(
      `Minimum basket: ${money(
        settings.minimumOrderPence
      )}`
    );


    console.log(
      `Shipping: ${money(
        settings.shippingPence
      )}`
    );


    console.log(
      `Low-stock threshold: ${settings.lowStockThreshold}`
    );


    console.log(
      `Affiliate discount: ${AFFILIATE_DISCOUNT_PERCENT}%`
    );


    console.log(
      `Affiliate commission: ${AFFILIATE_COMMISSION_PERCENT}%`
    );
  }
);