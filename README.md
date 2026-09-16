# Kage Gold/White Clean Build

This is a clean lawful-store scaffold with:
- gold/white Mini App UI
- basket and checkout form
- server-side order creation
- provider-neutral crypto payment placeholder
- authenticated webhook skeleton
- admin Telegram notifications
- /start bot menu

## Render
Build Command: `npm install`
Start Command: `npm start`

## Environment variables
- TELEGRAM_BOT_TOKEN
- WEBAPP_URL
- ADMIN_TELEGRAM_ID
- PAYMENT_WEBHOOK_SECRET

## Payment
The code does NOT include a live crypto provider.
Connect an approved payment provider to `/api/payment-webhook` and replace
the demo payment instructions in `/api/orders`.

For production, use a persistent database instead of the in-memory Map.
