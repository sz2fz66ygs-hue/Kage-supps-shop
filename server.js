
import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const products = [
  { id: 1, category: "Supplements", name: "Example Product A", subtitle: "Demo item", price: 14.99, stock: 18 },
  { id: 2, category: "Supplements", name: "Example Product B", subtitle: "Demo item", price: 19.99, stock: 7 },
  { id: 3, category: "Accessories", name: "Shaker Bottle", subtitle: "700ml", price: 7.99, stock: 24 },
  { id: 4, category: "Trial products", name: "Trial Pack", subtitle: "Limited demo", price: 9.99, stock: 6 }
];

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Kage Supps ⚡️</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{
  --bg:var(--tg-theme-bg-color,#fff);
  --text:var(--tg-theme-text-color,#111);
  --hint:var(--tg-theme-hint-color,#8e8e93);
  --btn:var(--tg-theme-button-color,#1689f8);
  --btntxt:var(--tg-theme-button-text-color,#fff);
  --card:var(--tg-theme-secondary-bg-color,#f2f2f7);
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid rgba(127,127,127,.2);z-index:10}
.brand{font-size:22px;font-weight:900;padding:14px 16px 8px;text-align:center}
.tabs{display:flex;overflow-x:auto;gap:18px;padding:0 14px;white-space:nowrap}
.tab{border:0;background:transparent;color:var(--hint);font-size:16px;padding:12px 2px;border-bottom:3px solid transparent}
.tab.active{color:var(--btn);border-bottom-color:var(--btn);font-weight:800}
main{padding:12px}
.card{background:var(--card);border-radius:18px;padding:16px;margin-bottom:12px;display:grid;grid-template-columns:1fr auto;gap:12px}
.name{font-size:18px;font-weight:850}.sub{color:var(--hint)}
.stock{display:inline-block;margin-top:8px;padding:4px 9px;border-radius:999px;background:#d9f7e7;color:#087a4b;font-weight:800}
.low{background:#fff0b8;color:#945900}.price{color:var(--btn);font-weight:900;font-size:19px;text-align:right}
.qty{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:12px}
.qty button{width:42px;height:42px;border:0;border-radius:50%;background:var(--btn);color:var(--btntxt);font-size:26px}
.count{font-weight:900;font-size:20px;min-width:18px;text-align:center}
.basket{margin-top:18px;border-top:1px solid rgba(127,127,127,.2);padding-top:16px}
.total{font-weight:900;font-size:20px;margin-top:12px}
.note{color:var(--hint);font-size:13px;margin-top:10px}
</style>
</head>
<body>
<header>
  <div class="brand">Kage Supps ⚡️</div>
  <div id="tabs" class="tabs"></div>
</header>
<main>
  <div id="products"></div>
  <section class="basket">
    <h2>🛒 Basket</h2>
    <div id="basketLines" style="color:var(--hint)">Your basket is empty.</div>
    <div id="total" class="total">Total: £0.00</div>
    <div class="note">Demo storefront.</div>
  </section>
</main>
<script>
const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}
const products=${JSON.stringify(products)};
const basket={};
const cats=[...new Set(products.map(p=>p.category))];
let current=cats[0];
const icons={"Supplements":"⚡️","Accessories":"🧴","Trial products":"🧪"};
const money=n=>"£"+n.toFixed(2);

function render(){
  document.getElementById("tabs").innerHTML=cats.map(c =>
    '<button class="tab '+(c===current?'active':'')+'" onclick="sel('+JSON.stringify(c).replaceAll('"','&quot;')+')">'+(icons[c]||"")+" "+c+"</button>"
  ).join("");
  const visible=products.filter(p=>p.category===current);
  document.getElementById("products").innerHTML=visible.map(p=>{
    const q=basket[p.id]||0;
    return '<div class="card"><div><div class="name">'+p.name+' <span class="sub">'+p.subtitle+'</span></div><span class="stock '+(p.stock<=10?'low':'')+'">'+(p.stock<=10?p.stock+' left':p.stock+' in stock')+'</span></div><div><div class="price">'+money(p.price)+'</div><div class="qty"><button onclick="chg('+p.id+',-1)">−</button><span class="count">'+q+'</span><button onclick="chg('+p.id+',1)">+</button></div></div></div>';
  }).join("");
  renderBasket();
}
window.sel=c=>{current=c;render();}
window.chg=(id,d)=>{
  const p=products.find(x=>x.id===id);
  const n=Math.max(0,Math.min(p.stock,(basket[id]||0)+d));
  if(n===0) delete basket[id]; else basket[id]=n;
  tg?.HapticFeedback?.selectionChanged();
  render();
}
function renderBasket(){
  const entries=Object.entries(basket);
  if(!entries.length){
    document.getElementById("basketLines").textContent="Your basket is empty.";
    document.getElementById("total").textContent="Total: £0.00";
    return;
  }
  let t=0;
  document.getElementById("basketLines").innerHTML=entries.map(([id,q])=>{
    const p=products.find(x=>x.id===Number(id)); const s=p.price*q; t+=s;
    return p.name+" × "+q+" = <b>"+money(s)+"</b>";
  }).join("<br>");
  document.getElementById("total").textContent="Total: "+money(t);
}
render();
</script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`Kage Supps Mini App running on port ${port}`);
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL;

if (token && webAppUrl) {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, async (msg) => {
    await bot.sendMessage(msg.chat.id, "⚡️ Kage Supps\\n\\nChoose an option below:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍 Open Shop", web_app: { url: webAppUrl } }],
          [
            { text: "📦 My Orders", callback_data: "orders" },
            { text: "💬 Support", callback_data: "support" }
          ],
          [{ text: "ℹ️ Info", callback_data: "info" }]
        ]
      }
    });
  });

  bot.on("callback_query", async (q) => {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    await bot.answerCallbackQuery(q.id);
    if (q.data === "orders") await bot.sendMessage(chatId, "📦 My Orders\\n\\nComing soon.");
    if (q.data === "support") await bot.sendMessage(chatId, "💬 Support\\n\\nSupport details can go here.");
    if (q.data === "info") await bot.sendMessage(chatId, "ℹ️ Kage Supps\\n\\nTap Open Shop to launch the Mini App.");
  });
}
