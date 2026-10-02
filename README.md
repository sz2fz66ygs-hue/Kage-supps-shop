# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket with add/remove cart controls, wired to checkout
- a fixed referral code (`Y8`) with first-use vs. repeat-use discount/commission tiers, plus a loyalty program that auto-mints a customer their own flat-rate referral code after 10 paid orders
- server-side order creation with prices/stock recalculated from the canonical product list
- automatic on-chain USDT (ERC-20, Ethereum mainnet) payment confirmation, with shipping details forwarded to the admin chat once confirmed
- authenticated webhook skeleton (for a separate payment provider, if you use one instead)
- admin Telegram notifications, including a weekly sales + basket-activity summary
- /start bot menu with /myid, /summary, and /earnings commands, real Support message forwarding, and a real My Orders lookup

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
- REFERRAL_DISCOUNT_PERCENT (default 10) — flat discount % on a customer's own loyalty-earned referral code (see below); does not affect `Y8`, which has its own fixed tiers
- REFERRAL_COMMISSION_PERCENT (default 5) — flat commission % on a customer's own loyalty-earned referral code; does not affect `Y8`
- ADMIN_API_SECRET (optional) — required to create flat, non-referral discount codes via the admin API
- ETH_RECEIVING_ADDRESS — your Ethereum wallet address, used to receive USDT (ERC-20) payments. Leave unset to disable crypto payment automation
- ETHERSCAN_API_KEY — API key used to look up transactions on-chain
- USDT_CONTRACT_ADDRESS (optional) — defaults to the mainnet USDT contract; only override where appropriate
- PAYMENT_TOLERANCE_PENCE (default 10) — how many pence the confirmed payment value may differ from the order total and still auto-confirm
- MIN_CONFIRMATIONS (default 2) — block confirmations required before a payment is accepted
- DATA_DIR (default `.`) — where the SQLite database file lives; point this at a Render Persistent Disk's mount path for data to survive redeploys

## Adding products

Every product goes in `public/products.json` — it's the single source of
truth: the storefront renders it and the server reads the exact same file to
price/validate every order, so a client cannot submit its own price or exceed
stock.

There's no separate display-only list; anything added here automatically gets
add/remove-to-basket controls.

Each entry needs:
- `id`
- `category`
- `section`
- `name`
- `stock`
- `unit`
- `pricePence`

`subtitle` is optional.

`category` / `section` must match one of the pairs defined in
`public/app.js` (`categories` / `sectionOrder`).

Anything sold must be legal to sell without a prescription in your
jurisdiction.

## Discount codes & referrals

There's no self-serve referral code generation anymore — codes come from two
places:

### `Y8`

`Y8` is one fixed code, seeded automatically on server startup if it doesn't
already exist, so it survives redeploys without any manual setup.

Its owner and rates are constants near the top of `server.js`:

- `Y8_OWNER`
- `Y8_FIRST_USE_DISCOUNT_PERCENT`
- `Y8_FIRST_USE_COMMISSION_PERCENT`
- `Y8_REPEAT_DISCOUNT_PERCENT`
- `Y8_REPEAT_COMMISSION_PERCENT`

Edit those directly to change the rates.

The code is tiered per buyer, tracked by Telegram identity.

The first order a given buyer places using `Y8` gets
`Y8_FIRST_USE_DISCOUNT_PERCENT` off and the owner earns
`Y8_FIRST_USE_COMMISSION_PERCENT`.

Every order after that from the same buyer using the same code gets the lower
repeat rate instead.

A different buyer's first order is still treated as "first use"
independently.

`Y8` is seeded with:

`cashOnly: true`

Its commission balance can therefore only be settled as a cash/manual payout
to its configured owner and cannot be spent as store credit by another user
who knows the code.

### Loyalty codes

Once a buyer reaches `LOYALTY_ORDER_THRESHOLD` (10) paid orders, they're
automatically minted their own flat-rate referral code.

The code uses the same naming scheme as the old self-serve system: their
sanitized Telegram name/username.

That code gives buyers:

`REFERRAL_DISCOUNT_PERCENT`

off, while the referrer earns:

`REFERRAL_COMMISSION_PERCENT`

commission.

These loyalty codes are not tiered.

If the system has a real Telegram chat ID for the customer, they get DMed
their new code.

Either way, the code shows next time they tap "My Orders", along with their
progress if they haven't reached the 10-order threshold yet.

## Discount/referral endpoints

### Validate a discount code

`GET /api/discount-codes/:code`

Used by the storefront's Apply button.

Accepts optional:

`?telegramId=&telegramUsername=`

so a tiered code can preview the rate that specific buyer would receive.

The order endpoint still recalculates it authoritatively.

### Check referral earnings

`GET /api/referral-codes/:code/earnings`

Returns:
- `commissionPence`
- `balancePence`
- `paidOutPence`

### Record a referral payout

`POST /api/referral-codes/:code/payout`

Admin only.

Requires:

`x-admin-secret`

matching:

`ADMIN_API_SECRET`

This endpoint records that you've paid the code owner outside the app.

It does not transfer money itself.

It debits `balancePence` by `amountPence`, or the entire balance if
`amountPence` is omitted.

Example endpoint:

`/api/referral-codes/Y8/payout`

### Create a standard discount code

`POST /api/discount-codes`

Admin only.

Requires:

`x-admin-secret`

matching:

`ADMIN_API_SECRET`

Creates a flat discount code with no referral attached.

## Buyer identity

The storefront passes the Telegram ID/username provided by Telegram when the
Mini App opens:

`tg.initDataUnsafe.user`

This is sent with every order instead of relying only on the free-text
username a buyer types in.

This makes:
- first-use/repeat tracking
- loyalty counters
- My Orders lookup

more reliable.

Orders placed outside a real Telegram Mini App session can fall back to the
typed username.

## Store credit

A loyalty referrer's commission can be used as store credit.

On:

`POST /api/orders`

pass:

`storeCreditCode`

and the order total is reduced by the available balance.

The credit is capped at:
- the code's available balance
- the remaining order total after any discount code

The code's `balancePence` is debited by the amount used.

The storefront's Store Credit Code field previews the available balance using
the referral earnings endpoint and then sends `storeCreditCode` on checkout.

Using store credit is not treated as a new referral use and does not generate
additional commission.

`Y8` is rejected as store credit because its referral record is:

`cashOnly: true`

This prevents a customer who knows `Y8` from spending the fixed-code owner's
commission balance.

## Tracking and paying out commission

There is no automatic bank or crypto payout from the referral system.

Commission is tracked and settled manually.

### `/earnings`

Telegram command, admin only.

Shows every referral code with:
- current balance owed
- lifetime earned
- lifetime paid out

Every time a referral code is used, the admin order notification can also
show:

`Referral: <owner> earns £X`

Once you've paid someone outside the app, call:

`POST /api/referral-codes/:code/payout`

to debit their recorded balance.

For the fixed code, that endpoint is:

`POST /api/referral-codes/Y8/payout`

All codes, referral earnings, and orders are stored in SQLite.

## Payment

Accepts USDT (ERC-20) on Ethereum mainnet.

Once:

`ETH_RECEIVING_ADDRESS`

and:

`ETHERSCAN_API_KEY`

are configured, `POST /api/orders` returns the payment quote and receiving
address.

The storefront displays this and lets the buyer submit the transaction hash.

### Confirm payment

`POST /api/orders/:id/confirm-payment`

Body:

`{ transactionId }`

The server checks the transaction and confirms:
- the correct token was transferred
- the recipient is `ETH_RECEIVING_ADDRESS`
- the required number of confirmations has been reached
- the amount is within `PAYMENT_TOLERANCE_PENCE` of the order total

If the checks succeed, the order is marked paid and shipping details plus the
item list are sent to `ADMIN_TELEGRAM_ID`.

## Support and My Orders

Tapping Support from `/start` puts that chat into a one-message support flow.

The next non-command message is forwarded to every Telegram ID configured in:

`SUPPORT_TELEGRAM_IDS`

and the customer gets a confirmation.

Tapping My Orders looks up that Telegram user against stored orders and lists
their 10 most recent orders with status and total.

## Weekly summary

Once `ADMIN_TELEGRAM_ID` is configured, the bot sends a weekly summary.

It can include, per product:
- units ordered
- units paid
- revenue
- basket additions
- complete basket removals before checkout

The system checks hourly against the persisted:

`lastWeeklySummaryAt`

timestamp.

Send:

`/summary`

to the bot at any time for an admin-only report covering the previous 7 days.

Basket events are recorded through:

`POST /api/cart-events`

with:
- product ID
- action
- timestamp

## Data persistence

Orders, discount/referral codes, referral earnings, basket events and the
weekly summary timestamp are stored in:

`<DATA_DIR>/kage.sqlite`

Orders, codes and earnings are loaded into memory on startup and written
through to SQLite whenever they change.

For Render persistence, point:

`DATA_DIR`

at the mount path of a Render Persistent Disk, for example:

`/data`

Without persistent storage, the SQLite database can be recreated on deploy.

Requires Node >= 22.5 because the project uses Node's built-in `node:sqlite`.