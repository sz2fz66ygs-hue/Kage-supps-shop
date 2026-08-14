import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

const categories = [
  { name: "Oil’s", icon: "🛢️" },
  { name: "Pharma", icon: "💊" },
  { name: "Oral Anabolic’s", icon: "💪" },
  { name: "Peps", icon: "⚡" },
  { name: "Trial products", icon: "🧪" }
];

const sectionOrder = {
  "Oil’s": ["Testosterone","DHT’s","19-Nor’s","Blends","Pre-Workouts"],
  "Pharma": ["Cycle Support","Hair & Skincare","Nootropics","Painkillers","Sexual Health"],
  "Oral Anabolic’s": ["Main Orals","Pre-Workout Orals","Other"],
  "Peps": ["Recovery","Performance","Weight Management","Other"],
  "Trial products": ["Current Trials","Coming Soon"]
};

// COPY A BLOCK BELOW TO ADD A PRODUCT.
// id must be unique.
// category and section must match the names above.
const products = [
  {
    id: 1,
    category: "Oil’s",
    section: "Testosterone",
    name: "Example Product",
    subtitle: "Demo listing",
    price: 25.00,
    stock: 10
  },
  {
    id: 2,
    category: "Pharma",
    section: "Hair & Skincare",
    name: "Example Product",
    subtitle: "Demo listing",
    price: 5.00,
    stock: 20
  },
  {
    id: 3,
    category: "Trial products",
    section: "Current Trials",
    name: "Example Trial Product",
    subtitle: "Limited demo",
    price: 10.00,
    stock: 0
  }
];

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Kage Supps ⚡️</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:var(--tg-theme-bg-color,#fff);--text:var(--tg-theme-text-color,#111);--hint:var(--tg-theme-hint-color,#8e8e93);--btn:var(--tg-theme-button-color,#1689f8);--btntxt:var(--tg-theme-button-text-color,#fff);--card:var(--tg-theme-secondary-bg-color,#f2f2f7);--border:rgba(127,127,127,.18)}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--border)}
.brand{text-align:center;font-size:24px;font-weight:900;padding:14px 16px 8px}
.tabs{display:flex;gap:22px;overflow-x:auto;white-space:nowrap;padding:0 16px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{border:0;background:transparent;color:var(--hint);font-size:16px;font-weight:700;padding:12px 0 13px;border-bottom:3px solid transparent}
.tab.active{color:var(--btn);border-bottom-color:var(--btn)}
main{padding:14px}
.section-title{margin:22px 8px 12px;color:var(--hint);font-size:16px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase}
.card{background:var(--card);border-radius:18px;padding:16px;margin-bottom:12px;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center}
.name{font-size:18px;font-weight:900}.sub{display:block;color:var(--hint);font-size:15px;margin-top:4px}
.stock{display:inline-block;margin-top:10px;padding:5px 10px;border-radius:999px;font-size:14px;font-weight:800}
.good{background:#d9f7e7;color:#087a4b}.low{background:#fff0b8;color:#945900}.out{background:#ffdede;color:#a22525}
.price{color:var(--btn);font-weight:900;font-size:20px;text-align:right}
.qty{display:flex;align-items:center;gap:12px;justify-content:flex-end;margin-top:12px}
.qty button{width:44px;height:44px;border:0;border-radius:50%;background:var(--btn);color:var(--btntxt);font-size:28px}
.qty button:disabled{opacity:.35}.count{font-size:20px;font-weight:900;min-width:18px;text-align:center}
.empty{color:var(--hint);padding:6px 10px 2px;font-size:15px}
.basket{border-top:1px solid var(--border);margin-top:24px;padding-top:18px}.basket h2{font-size:28px;margin:0 0 14px}
.lines{color:var(--hint);font-size:17px;line-height:1.7}.total{font-size:24px;font-weight:900;margin-top:14px}.demo{margin-top:12px;color:var(--hint);font-size:13px}
</style>
</head>
<body>
<header><div class="brand">Kage Supps ⚡️</div><div id="tabs" class="tabs"></div></header>
<main>
  <section id="products"></section>
  <section class="basket">
    <h2>🛒 Basket</h2>
    <div id="basketLines" class="lines">Your basket is empty.</div>
    <div id="total" class="total">Total: £0.00</div>
    <div class="demo">Demo storefront — checkout/order submission is not enabled.</div>
  </section>
</main>
<script>
const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}
const categories=${JSON.stringify(categories)};
const sectionOrder=${JSON.stringify(sectionOrder)};
const products=${JSON.stringify(products)};
const basket={};let current=categories[0].name;
const money=n=>"£"+Number(n).toFixed(2);

function renderTabs(){
  tabs.innerHTML=categories.map(c=>'<button class="tab '+(c.name===current?'active':'')+'" data-cat="'+c.name+'">'+c.icon+' '+c.name+'</button>').join("");
  document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{current=b.dataset.cat;render();});
}
function stockBadge(stock){
  if(stock<=0)return '<span class="stock out">Out of stock</span>';
  if(stock<=10)return '<span class="stock low">'+stock+' left</span>';
  return '<span class="stock good">'+stock+' in stock</span>';
}
function card(p){
  const q=basket[p.id]||0;
  return '<div class="card"><div><div class="name">'+p.name+'<span class="sub">'+(p.subtitle||"")+'</span></div>'+stockBadge(p.stock)+'</div><div><div class="price">'+money(p.price)+'</div><div class="qty"><button data-id="'+p.id+'" data-d="-1" '+(q===0?'disabled':'')+'>−</button><span class="count">'+q+'</span><button data-id="'+p.id+'" data-d="1" '+(p.stock<=0?'disabled':'')+'>+</button></div></div></div>';
}
function renderProducts(){
  let html="";
  (sectionOrder[current]||[]).forEach(section=>{
    const items=products.filter(p=>p.category===current&&p.section===section);
    html+='<div class="section-title">'+section+'</div>';
    html+=items.length?items.map(card).join(""):'<div class="empty">No products added yet.</div>';
  });
  document.getElementById("products").innerHTML=html;
  document.querySelectorAll("[data-d]").forEach(b=>b.onclick=()=>{
    const id=Number(b.dataset.id),d=Number(b.dataset.d),p=products.find(x=>x.id===id);
    const next=Math.max(0,Math.min(p.stock,(basket[id]||0)+d));
    if(next===0)delete basket[id];else basket[id]=next;
    tg?.HapticFeedback?.selectionChanged();render();
  });
}
function renderBasket(){
  const entries=Object.entries(basket);
  if(!entries.length){basketLines.textContent="Your basket is empty.";total.textContent="Total: £0.00";return;}
  let t=0;basketLines.innerHTML=entries.map(([id,q])=>{const p=products.find(x=>x.id===Number(id));const s=p.price*q;t+=s;return p.name+" × "+q+" = <b>"+money(s)+"</b>";}).join("<br>");
  total.textContent="Total: "+money(t);
}
function render(){renderTabs();renderProducts();renderBasket();}
render();
</script>
</body>
</html>`);
});

app.listen(port,()=>console.log(`Kage Supps Mini App running on port ${port}`));

const token=process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl=process.env.WEBAPP_URL;

if(token&&webAppUrl){
  const bot=new TelegramBot(token,{polling:true});
  bot.onText(/\/start/,async msg=>{
    await bot.sendMessage(msg.chat.id,`⚡️ Welcome to Kage Supps

Your shop, orders and support are all in one place.

🛍 Open Shop — browse the store
📦 My Orders — view your order history
💬 Support — get help
ℹ️ Info — important information

Choose an option below 👇`,{
      reply_markup:{inline_keyboard:[
        [{text:"🛍 Open Shop",web_app:{url:webAppUrl}}],
        [{text:"📦 My Orders",callback_data:"orders"},{text:"💬 Support",callback_data:"support"}],
        [{text:"ℹ️ Info",callback_data:"info"}]
      ]}
    });
  });
}
