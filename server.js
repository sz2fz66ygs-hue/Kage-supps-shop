import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/products", (_req, res) => {
  res.json([
    {
      id: 1,
      category: "Supplements",
      name: "Example Product A",
      subtitle: "Demo item",
      pricePence: 1499,
      stock: 18
    },
    {
      id: 2,
      category: "Supplements",
      name: "Example Product B",
      subtitle: "Demo item",
      pricePence: 1999,
      stock: 7
    },
    {
      id: 3,
      category: "Accessories",
      name: "Shaker Bottle",
      subtitle: "700ml",
      pricePence: 799,
      stock: 24
    },
    {
      id: 4,
      category: "Trial products",
      name: "Trial Pack",
      subtitle: "Limited demo",
      pricePence: 999,
      stock: 6
    }
  ]);
});

app.listen(port, () => {
  console.log(`Kage Supps Mini App running on port ${port}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;

if (token && webAppUrl) {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      "👋 Welcome to Kage Supps ⚡️\n\n🛍 Tap the button below to open the shop.",
      {
        reply_markup: {
          keyboard: [[
            {
              text: "🛍 OPEN SHOP — TAP HERE",
              web_app: { url: webAppUrl }
            }
          ]],
          resize_keyboard: true,
          is_persistent: true
        }
      }
    );
  });

  console.log("Telegram bot polling started");
} else {
  console.log("Telegram bot not started: set TELEGRAM_BOT_TOKEN and WEBAPP_URL");
}
