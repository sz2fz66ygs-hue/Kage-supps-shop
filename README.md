# Kage Supps ⚡️ Telegram Mini App — Node.js starter

This is a JavaScript/Node.js version of the Telegram Mini App starter.

## What it includes

- Telegram `/start` bot
- Big `🛍 OPEN SHOP — TAP HERE` Web App button
- Kage Supps ⚡️ branding
- Horizontal product categories
- Product cards
- Stock badges
- +/- quantity controls
- Basket preview
- Telegram theme support
- Mobile-first layout

This starter intentionally keeps checkout/order submission disabled. It is suitable as a storefront/demo and can be extended for lawful, non-regulated products.

## Run locally

1. Install Node.js 20+
2. Open this folder in Terminal
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env`
5. Put your Telegram bot token into `.env`
6. Start the web app:

```bash
npm run dev
```

The local URL will be:

```text
http://localhost:3000
```

Telegram requires a public HTTPS URL for a Mini App.

## Start the Telegram bot

The same `server.js` file starts the bot as well, as long as `TELEGRAM_BOT_TOKEN`
and `WEBAPP_URL` are set.

## Hosting

You can deploy this as a normal Node.js web service.

Start command:

```bash
npm start
```

Once hosted, copy the HTTPS URL into BotFather's Main App URL field.
