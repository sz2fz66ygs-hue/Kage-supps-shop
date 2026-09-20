# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket with add/remove cart controls, wired to checkout
- discount codes and self-serve referral codes (buyer discount + referrer commission)
- server-side order creation with prices/stock recalculated from the canonical product list
- automatic on-chain USDT (ERC-20, Ethereum mainnet) payment confirmation, with shipping details forwarded to the admin chat once confirmed
- authenticated webhook skeleton (for a separate payment provider, if you use one instead)
- admin Telegram notifications, including a weekly sales + basket-activity summary
- /start bot menu with /refer, /myid and /summary commands

## Render
Build Command: `npm install`
Start Command: `npm start`

## Getting order/shipping notifications and weekly summaries
`ADMIN_TELEGRAM_ID` has to be set for you to receive anything from the bot
(new orders, payment confirmations with shipping details, weekly summaries).
To find your numeric Telegram ID: message your own bot with `/myid`, it
replies with your ID, set that as `ADMIN_TELEGRAM_ID` in Render's environment
variables, and redeploy.

## Environment variables
- TELEGRAM_BOT_TOKEN
- WEBAPP_URL
- ADMIN_TELEGRAM_ID — see above; without this, order/payment/summary messages have nowhere to go
- PAYMENT_WEBHOOK_SECRET
- REFERRAL_DISCOUNT_PERCENT (default 10) — % off given to a buyer who uses a referral code
- REFERRAL_COMMISSION_PERCENT (default 5) — % of the order the referrer earns
- ADMIN_API_SECRET (optional) — required to create flat, non-referral discount codes via the admin API
- ETH_RECEIVING_ADDRESS — your Ethereum wallet address, used to receive USDT (ERC-20) payments. Leave unset to disable crypto payment automation (orders fall back to a generic "not configured" message).
- ETHERSCAN_API_KEY — a free API key from https://etherscan.io/apis, used to look up transactions on-chain
- USDT_CONTRACT_ADDRESS (optional) — defaults to the real mainnet USDT contract; only override for a testnet
- PAYMENT_TOLERANCE_PENCE (default 10) — how many pence the on-chain amount (converted to GBP at the live rate) may differ from the order total and still auto-confirm
- MIN_CONFIRMATIONS (default 2) — block confirmations required before a payment is accepted
- DATA_DIR (default `.`) — where the SQLite database file lives; point this at a Render Persistent Disk's mount path for data to survive redeploys (see **Data persistence** below)

## Adding products
Only lawful, purchasable products go in `public/products.json`. It's the
single source of truth: the storefront renders it and the server reads the
exact same file to price/validate every order, so a client can never submit
its own price or exceed stock. Each entry needs `id`, `category`, `section`,
`name`, `stock`, `unit` and `pricePence`; `subtitle` is optional. `category`/
`section` must match the ones the storefront defines in `public/app.js`
(`categories` / `sectionOrder`).

Anything sold must be legal to sell without a prescription in your
jurisdiction. The catalogue in `public/app.js` (`displayProducts`) is kept
separate and intentionally display-only — it is never wired into the basket
or checkout.

## Discount codes & referrals
- A referral code is just the person's Telegram name/username, sanitized and
  uppercased (e.g. `@jane_doe` → `JANE_DOE`) — simple to read out loud, and
  already unique per person. Asking again for the same owner returns the same
  code rather than minting a new one.
- `POST /api/referral-codes` `{ ownerName | ownerTelegramUsername }` — anyone
  can self-serve generate a referral code. Buyers who use it get
  `REFERRAL_DISCOUNT_PERCENT` off; the referrer earns
  `REFERRAL_COMMISSION_PERCENT` of each resulting order.
- Telegram users can also just send `/refer` to the bot, or tap "Refer & Earn"
  from `/start`, to get their own code.
- `GET /api/discount-codes/:code` — validate a code (used by the storefront's
  "Apply" button) without revealing who owns it.
- `GET /api/referral-codes/:code/earnings` — check a referral code's lifetime
  commission (`commissionPence`) and current spendable balance
  (`balancePence`).
- `POST /api/discount-codes` (admin only, needs `x-admin-secret` header
  matching `ADMIN_API_SECRET`) — create a flat discount code with no referral
  attached.

**Store credit**: a referrer's commission is real, spendable store credit —
not just a number to look up and pay out manually. On `POST /api/orders`,
pass `storeCreditCode` (their own referral code) and the order total is
reduced by whatever balance is available (capped at the order total and at
the remaining balance after any `discountCode` is applied); the code's
`balancePence` is debited by the same amount. The storefront's "Store credit
code" field does this — it previews the available balance via the earnings
endpoint above, then sends `storeCreditCode` on checkout. There's no
ownership check beyond knowing the code, same as everywhere else in this
demo, and it isn't a new referral use, so applying it doesn't earn further
commission.

All codes, referral earnings, and orders are persisted to a SQLite database
(see **Data persistence** below) — see that section before relying on any of
this in production.

## Payment
Accepts USDT (ERC-20) on Ethereum mainnet only. Once `ETH_RECEIVING_ADDRESS`
(despite the name, this is just your Ethereum wallet address — the same
address receives ERC-20 tokens like USDT) and `ETHERSCAN_API_KEY` are set,
`POST /api/orders` returns a live quote (approximate USDT amount for the
order total) and your receiving address. The storefront shows this and lets
the buyer submit the transaction hash they sent it with.

`POST /api/orders/:id/confirm-payment` `{ transactionId }` then looks the
transaction up on-chain via Etherscan, checks:
- it's an ERC-20 `Transfer` of USDT to `ETH_RECEIVING_ADDRESS`
- it has at least `MIN_CONFIRMATIONS` confirmations
- the paid amount, converted to GBP at the live rate, is within
  `PAYMENT_TOLERANCE_PENCE` of the order total

If it matches, the order is marked paid and the shipping address + item list
is sent to `ADMIN_TELEGRAM_ID` for fulfillment. If not, the buyer gets back
exactly why (wrong recipient, not enough confirmations, amount mismatch, etc.)
so they can fix it and resubmit.

This only supports USDT (ERC-20) on Ethereum mainnet for now. If you want ETH
itself, Bitcoin, Tron/USDT-TRC20, or another chain, that's a similar shape (a
different explorer API and/or address format) — ask and it can be added the
same way. Alternatively, plug a payment provider into `/api/payment-webhook`
instead.

## Weekly summary
Once `ADMIN_TELEGRAM_ID` is set, the bot sends a weekly message covering, per
product, since the last summary: units ordered, units paid (+ revenue), how
many times it was added to a basket, and how many times it was fully removed
before checkout. It's a plain hourly check against a `lastWeeklySummaryAt`
timestamp (persisted, so it survives restarts) rather than a cron job — no
extra dependency, but it means the exact send time can drift by up to an
hour. Send `/summary` to the bot any time (admin only) for the same report
covering the trailing 7 days on demand.

Basket add/remove events are recorded by the storefront on every add-to-basket
and every full removal (not on every +/- quantity tweak) via
`POST /api/cart-events` — best-effort, fire-and-forget, no personal data
attached (just a product id, an action, and a timestamp).

## Data persistence
Orders, discount/referral codes, referral earnings, basket add/remove events,
and the weekly summary's last-sent timestamp are all stored in a SQLite
database (via Node's built-in `node:sqlite`, so no extra service or
dependency) at `<DATA_DIR>/kage.sqlite`. Orders/codes/earnings are loaded into
memory on startup and written through on every change; cart events and meta
values are read/written straight from the database.

**This only survives redeploys if `DATA_DIR` points at a Render Persistent
Disk** (Render dashboard → your service → Disks → add a disk, then set
`DATA_DIR` to its mount path, e.g. `/data`). Render web services otherwise
have an ephemeral filesystem — without a disk attached, the database file is
recreated empty on every deploy, same as the old in-memory-only version. If
you'd rather use a real hosted database (e.g. Render Postgres) instead of a
disk, that's a reasonable upgrade path — ask and it can be swapped in.

Requires Node >= 22.5 (`node:sqlite` is experimental as of this Node version;
`.node-version` and `engines.node` are set so Render provisions a compatible
version).
