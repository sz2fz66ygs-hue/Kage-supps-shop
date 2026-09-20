# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket with add/remove cart controls, wired to checkout
- a fixed referral code (`BIGLADSLIM`) with first-use vs. repeat-use discount/commission tiers, plus a loyalty program that auto-mints a customer their own flat-rate referral code after 10 paid orders
- server-side order creation with prices/stock recalculated from the canonical product list
- automatic on-chain USDT (ERC-20, Ethereum mainnet) payment confirmation, with shipping details forwarded to the admin chat once confirmed
- authenticated webhook skeleton (for a separate payment provider, if you use one instead)
- admin Telegram notifications, including a weekly sales + basket-activity summary
- /start bot menu with /myid and /summary commands, real Support message forwarding, and a real My Orders lookup

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
- SUPPORT_TELEGRAM_IDS (optional) — comma-separated numeric Telegram IDs (e.g. `123,456`) that receive forwarded support messages. Without this, tapping "Support" tells the customer it isn't configured yet.
- PAYMENT_WEBHOOK_SECRET
- REFERRAL_DISCOUNT_PERCENT (default 10) — flat discount % on a customer's own loyalty-earned referral code (see below); does not affect `BIGLADSLIM`, which has its own fixed tiers
- REFERRAL_COMMISSION_PERCENT (default 5) — flat commission % on a customer's own loyalty-earned referral code; does not affect `BIGLADSLIM`
- ADMIN_API_SECRET (optional) — required to create flat, non-referral discount codes via the admin API
- ETH_RECEIVING_ADDRESS — your Ethereum wallet address, used to receive USDT (ERC-20) payments. Leave unset to disable crypto payment automation (orders fall back to a generic "not configured" message).
- ETHERSCAN_API_KEY — a free API key from https://etherscan.io/apis, used to look up transactions on-chain
- USDT_CONTRACT_ADDRESS (optional) — defaults to the real mainnet USDT contract; only override for a testnet
- PAYMENT_TOLERANCE_PENCE (default 10) — how many pence the on-chain amount (converted to GBP at the live rate) may differ from the order total and still auto-confirm
- MIN_CONFIRMATIONS (default 2) — block confirmations required before a payment is accepted
- DATA_DIR (default `.`) — where the SQLite database file lives; point this at a Render Persistent Disk's mount path for data to survive redeploys (see **Data persistence** below)

## Adding products
Every product goes in `public/products.json` — it's the single source of
truth: the storefront renders it and the server reads the exact same file to
price/validate every order, so a client can never submit its own price or
exceed stock. There's no separate display-only list; anything added here
automatically gets add/remove-to-basket controls. Each entry needs `id`,
`category`, `section`, `name`, `stock`, `unit` and `pricePence`; `subtitle`
is optional. `category`/`section` must match one of the pairs defined in
`public/app.js` (`categories` / `sectionOrder`).

Anything sold must be legal to sell without a prescription in your
jurisdiction.

## Discount codes & referrals
There's no self-serve referral code generation anymore — codes come from two
places:

**`BIGLADSLIM`** — one fixed code, seeded automatically on server startup if
it doesn't already exist (so it survives redeploys without any manual setup).
Its owner and rates are constants near the top of `server.js`
(`BIGLADSLIM_OWNER`, `BIGLADSLIM_FIRST_USE_DISCOUNT_PERCENT`, etc.) — edit
those directly to change them. It's tiered **per buyer**, tracked by Telegram
identity (see below): the first order a given buyer places using this code
gets `BIGLADSLIM_FIRST_USE_DISCOUNT_PERCENT` off and the owner earns
`BIGLADSLIM_FIRST_USE_COMMISSION_PERCENT`; every order after that from the
same buyer using the same code gets the lower repeat rate instead. A
different buyer's first order is still treated as "first use" independently.

**Loyalty codes** — once a buyer reaches `LOYALTY_ORDER_THRESHOLD` (10) paid
orders, they're automatically minted their own flat-rate referral code (same
naming as the old self-serve scheme: their sanitized Telegram
name/username), giving buyers of *that* code `REFERRAL_DISCOUNT_PERCENT` off
and this customer `REFERRAL_COMMISSION_PERCENT` commission — not tiered. If
we have a real chat id for them (see below), they get DMed their new code;
either way it shows up next time they tap "My Orders", along with their
progress if they haven't reached 10 yet.

Other endpoints:
- `GET /api/discount-codes/:code` — validate a code (used by the storefront's
  "Apply" button) without revealing who owns it. Accepts optional
  `?telegramId=&telegramUsername=` so a tiered code can preview the rate
  *this* buyer would actually get; the order endpoint recomputes it
  authoritatively regardless.
- `GET /api/referral-codes/:code/earnings` — check a code's lifetime
  commission (`commissionPence`) and current spendable balance
  (`balancePence`).
- `POST /api/discount-codes` (admin only, needs `x-admin-secret` header
  matching `ADMIN_API_SECRET`) — create a flat discount code with no referral
  attached.

**Buyer identity**: the storefront now passes the Telegram id/username
Telegram itself gives the Mini App on open (`tg.initDataUnsafe.user`) with
every order, instead of relying solely on the free-text field a buyer types
in. This is what makes first-use/repeat tracking and the loyalty counter
possible. It's not cryptographically verified (`initDataUnsafe` is
convenience data, not a signed proof) — a determined client could still spoof
it — but it's far more reliable than free text, and orders placed before this
change (or outside a real Telegram session) fall back to the typed username.

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

## Support and My Orders
Tapping "Support" from `/start` puts that chat into a one-message support
flow: whatever the customer sends next (as long as it's not another command)
gets forwarded verbatim to every ID in `SUPPORT_TELEGRAM_IDS`, and the
customer gets a confirmation. Each recipient needs their numeric Telegram ID
the same way as `ADMIN_TELEGRAM_ID` (send `/myid` to the bot).

Tapping "My Orders" looks up the tapping user's Telegram `username` against
`telegramUsername` on stored orders (case-insensitive, leading `@` ignored)
and lists their 10 most recent, with status and total. This only works if
the customer has a Telegram username set and entered it accurately at
checkout — there's no login, so it's a best-effort match, not authenticated
account history.

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
