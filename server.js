import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const products = [
  { id: 1, category: "Oil’s", name: "Demo Oil Product", subtitle: "Example listing", price: 20.00, stock: 18 },
  { id: 2, category: "Oral Anabolic’s", name: "Demo Oral Product", subtitle: "Example listing", price: 18.00, stock: 7 },
  { id: 3, category: "Peps", name: "Demo Peptide Product", subtitle: "Example listing", price: 22.00, stock: 12 },
  { id: 4, category: "Pharma", name: "Demo Pharma Product", subtitle: "Example listing", price: 6.50, stock: 49 },
  { id: 5, category: "Trial products", name: "Demo Trial Product", subtitle: "Limited demo", price: 10.00, stock: 6 }
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
header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid rgba(127,127,127,.18)}
.brand{text-align:center;font-size:24px;font-weight:900;padding:14px 16px 8px}
.tabs{display:flex;gap:22px;overflow-x:auto;white-space:nowrap;padding:0 16px;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{border:0;background:transparent;color:var(--hint);font-size:16px;font-weight:700;padding:12px 0 13px;border-bottom:3px solid transparent}
.tab.active{color:var(--btn);border-bottom-color:var(--btn)}
main{padding:14px}
.card{background:var(--card);border-radius:18px;padding:16px;margin-bottom:12px;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center}
.name{font-size:18px;font-weight:900}
.sub{display:block;color:var(--hint);font-size:15px;margin-top:4px}
.stock{display:inline-block;margin-top:10px;padding:5px 10px;border-radius:999px;background:#d9f7e7;color:#087a4b;font-weight:800}
.stock.low{background:#fff0b8;color:#945900}
.price{color:var(--btn);font-weight:900;font-size:20px;text-align:right}
.qty{display:flex;align-items:center;gap:12px;justify-content:flex-end;margin-top:12px}
.qty button{width:44px;height:44px;border:0;border-radius:50%;background:var(--btn);color:var(--btntxt);font-size:28px}
.minus{opacity:.45}
.count{font-size:20px;font-weight:900;min-width:18px;text-align:center}
.basket{border-top:1px solid rgba(127,127,127,.18);margin-top:20px;padding-top:18px}
.basket h2{font-size:28px;margin:0 0 14px}
.lines{color:var(--hint);font-size:17px;line-height:1.7}
.total{font-size:24px;font-weight:900;margin-top:14px}
.demo{margin-top:12px;color:var(--hint);font-size:13px}
</style>
</head>
<body>
<header>
  <div class="brand">Kage Supps ⚡️</div>
  <div id="tabs" class="tabs"></div>
</header>
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
const tg=window.Telegram?.WebApp;
if(tg){tg.ready();tg.expand();}

const products=${JSON.stringify(products)};
const categories=["Oil’s","Oral Anabolic’s","Peps","Pharma","Trial products"];
const icons={"Oil’s":"🛢️","Oral Anabolic’s":"💪","Peps":"⚡","Pharma":"💊","Trial products":"🧪"};
const basket={};
let current=categories[0];
const money=n=>"£"+n.toFixed(2);

function renderTabs(){
  document.getElementById("tabs").innerHTML=categories.map(c =>
    '<button class="tab '+(c===current?'active':'')+'" data-cat="'+c+'">'+(icons[c]||"")+" "+c+'</button>'
  ).join("");
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.addEventListener("click",()=>{
      current=btn.dataset.cat;
      render();
    });
  });
}

function renderProducts(){
  const visible=products.filter(p=>p.category===current);
  document.getElementById("products").innerHTML=visible.map(p=>{
    const q=basket[p.id]||0;
    return '<div class="card">'+
      '<div>'+
        '<div class="name">'+p.name+'<span class="sub">'+p.subtitle+'</span></div>'+
        '<span class="stock '+(p.stock<=10?'low':'')+'">'+(p.stock<=10?p.stock+' left':p.stock+' in stock')+'</span>'+
      '</div>'+
      '<div>'+
        '<div class="price">'+money(p.price)+'</div>'+
        '<div class="qty">'+
          '<button class="minus" data-id="'+p.id+'" data-d="-1">−</button>'+
          '<span class="count">'+q+'</span>'+
          '<button data-id="'+p.id+'" data-d="1">+</button>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join("");

  document.querySelectorAll("[data-d]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const id=Number(btn.dataset.id);
      const d=Number(btn.dataset.d);
      const p=products.find(x=>x.id===id);
      const next=Math.max(0,Math.min(p.stock,(basket[id]||0)+d));
      if(next===0) delete basket[id];
      else basket[id]=next;
      tg?.HapticFeedback?.selectionChanged();
      render();
    });
  });
}

function renderBasket(){
  const entries=Object.entries(basket);
  if(!entries.length){
    document.getElementById("basketLines").textContent="Your basket is empty.";
    document.getElementById("total").textContent="Total: £0.00";
    return;
  }

  let total=0;
  document.getElementById("basketLines").innerHTML=entries.map(([id,q])=>{
    const p=products.find(x=>x.id===Number(id));
    const subtotal=p.price*q;
    total+=subtotal;
    return p.name+" × "+q+" = <b>"+money(subtotal)+"</b>";
  }).join("<br>");
  document.getElementById("total").textContent="Total: "+money(total);
}

function render(){
  renderTabs();
  renderProducts();
  renderBasket();
}
render();
</script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`Kage Supps Mini App running on port ${port}`);
});

const token=process.env.TELEGRAM_BOT_TOKEN;
const webAppUrl=process.env.WEBAPP_URL;

if(token && webAppUrl){
  const bot=new TelegramBot(token,{polling:true});

  bot.onText(/\/start/,async msg=>{
    await bot.sendMessage(
      msg.chat.id,
      "⚡️ Kage Supps\\n\\nWelcome. Choose an option below:",
      {
        reply_markup:{
          inline_keyboard:[
            [{text:"🛍 Open Shop",web_app:{url:webAppUrl}}],
            [
              {text:"📦 My Orders",callback_data:"orders"},
              {text:"💬 Support",callback_data:"support"}
            ],
            [{text:"ℹ️ Info",callback_data:"info"}]
          ]
        }
      }
    );
  });

  bot.on("callback_query",async q=>{
    const chatId=q.message?.chat?.id;
    if(!chatId) return;

    await bot.answerCallbackQuery(q.id);

    if(q.data==="orders"){
      await bot.sendMessage(chatId,"📦 My Orders\\n\\nThis section can be connected later.");
    }
    if(q.data==="support"){
      await bot.sendMessage(chatId,"💬 Support\\n\\nAdd your support details here.");
    }
    if(q.data==="info"){
      await bot.sendMessage(chatId,"ℹ️ Kage Supps\\n\\nTap 🛍 Open Shop to launch the Mini App.");
    }
  });
}
