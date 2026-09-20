# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket with add/remove cart controls, wired to checkout
- discount codes and self-serve referral codes (buyer discount + referrer commission)
- server-side order creation with prices/stock recalculated from the canonical product list
- automatic on-chain ETH / USDT (ERC-20) payment confirmation, with shipping details forwarded to the admin chat once confirmed
- authenticated webhook skeleton (for a separate payment provider, if you use one instead)
- admin Telegram notifications
- /start bot menu with a /refer command

## Render
Build Command: `npm install`
Start Command: `npm start`

## Environment variables
- TELEGRAM_BOT_TOKEN
- WEBAPP_URL
- ADMIN_TELEGRAM_ID
- PAYMENT_WEBHOOK_SECRET
- REFERRAL_DISCOUNT_PERCENT (default 10) — % off given to a buyer who uses a referral code
- REFERRAL_COMMISSION_PERCENT (default 5) — % of the order the referrer earns
- ADMIN_API_SECRET (optional) — required to create flat, non-referral discount codes via the admin API
- ETH_RECEIVING_ADDRESS — your Ethereum wallet address to receive ETH/USDT payments. Leave unset to disable crypto payment automation (orders fall back to a generic "not configured" message).
- ETHERSCAN_API_KEY — a free API key from https://etherscan.io/apis, used to look up transactions on-chain
- USDT_CONTRACT_ADDRESS (optional) — defaults to the real mainnet USDT contract; only override for a testnet
- PAYMENT_TOLERANCE_PENCE (default 10) — how many pence the on-chain amount (converted to GBP at the live rate) may differ from the order total and still auto-confirm
- MIN_CONFIRMATIONS (default 2) — block confirmations required before a payment is accepted

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

All codes and referral earnings are stored in-memory and reset on restart —
move them to a persistent database for production, same as orders.

## Payment
Once `ETH_RECEIVING_ADDRESS` and `ETHERSCAN_API_KEY` are set, `POST /api/orders`
returns a live quote (approximate ETH and USDT amounts for the order total) and
your receiving address. The storefront shows this and lets the buyer submit
the transaction hash they sent it with.

`POST /api/orders/:id/confirm-payment` `{ transactionId, asset }` (`asset` is
`"ETH"` or `"USDT"`) then looks the transaction up on-chain via Etherscan,
checks:
- it was sent to `ETH_RECEIVING_ADDRESS` (for USDT, as an ERC-20 `Transfer` to
  that address from the token contract)
- it has at least `MIN_CONFIRMATIONS` confirmations
- the paid amount, converted to GBP at the live rate, is within
  `PAYMENT_TOLERANCE_PENCE` of the order total

If it matches, the order is marked paid and the shipping address + item list
is sent to `ADMIN_TELEGRAM_ID` for fulfillment. If not, the buyer gets back
exactly why (wrong recipient, not enough confirmations, amount mismatch, etc.)
so they can fix it and resubmit.

This only supports Ethereum mainnet (ETH and USDT ERC-20) for now. If you want
Bitcoin, Tron/USDT-TRC20, or another chain, that's a similar shape (a
different explorer API and address format) — ask and it can be added the same
way. Alternatively, plug a payment provider into `/api/payment-webhook` instead.

For production, use a persistent database instead of the in-memory Map —
orders, discount codes, and referral earnings are all lost on restart.
