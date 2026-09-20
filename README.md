# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket with add/remove cart controls, wired to checkout
- discount codes and self-serve referral codes (buyer discount + referrer commission)
- server-side order creation with prices/stock recalculated from the canonical product list
- provider-neutral crypto payment placeholder
- authenticated webhook skeleton
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
- `GET /api/referral-codes/:code/earnings` — check a referral code's accrued
  commission.
- `POST /api/discount-codes` (admin only, needs `x-admin-secret` header
  matching `ADMIN_API_SECRET`) — create a flat discount code with no referral
  attached.

All codes and referral earnings are stored in-memory and reset on restart —
move them to a persistent database for production, same as orders.

## Payment
The code does NOT include a live crypto provider.
Connect an approved payment provider to `/api/payment-webhook` and replace
the demo payment instructions in `/api/orders`.

For production, use a persistent database instead of the in-memory Map.
