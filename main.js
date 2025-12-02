// pump-bundle-watch.js
const WebSocket = require("ws");
const axios = require("axios");

// CONFIG
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1445037632638947371/ivpVM-yYXgZns66PiwtSRlcgHBjrFAEgfdxW2koOvchceiS4wsSL3RaGdk1TEkI20HF1";
const WS_URL = "wss://pumpportal.fun/api/data";

// Tuning
const BUNDLE_WINDOW_MS = 3000;
const MIN_TRADES = 2;
const MIN_TOTAL_SOL = 5;
const BIG_SINGLE_BUY_SOL = 4;

// ❗ NEW: chỉ ping nếu marketcap >= 30K$
const MIN_MARKETCAP_USD = 30000;

// bạn có thể chỉnh nếu SOL pump/dump
const SOL_PRICE_USD = 120;
const MIN_MARKETCAP_SOL = MIN_MARKETCAP_USD / SOL_PRICE_USD;  // ~250 SOL

const DEBUG_TRADES = true;

const perMint = {};
let ws = null;

function now(){return Date.now();}
function log(m){console.log(`[${new Date().toLocaleTimeString()}] ${m}`)}

function ensureMint(m){
  if(!perMint[m]){
    perMint[m] = {
      createdAt: now(),
      lastVSOL: null,
      trades: [],
      alerted:false,
      name:null,
      marketCapSol:0
    };
  }
  return perMint[m];
}

function extractSolGeneric(e) {
  if (e.solAmount>0) return e.solAmount;
  if (e.sol>0) return e.sol;
  if (e.lamports>0) return e.lamports/1e9;
  if (e.amount>0) return e.amount>1e6?e.amount/1e9:e.amount;
  return 0;
}

function classifyBundle(totalSol, maxSingle) {
  if (maxSingle >= 15) return "🐳 80%";
  if (maxSingle >= 8 || totalSol >= 12) return "🚀 60%";
  if (totalSol >= 5) return "🧨 50%";
  return "📌 BUNDLE";
}

async function sendAlert(mint, stats){
  const { trades, totalSol, maxSingle, dominancePercent, windowSec, createdAt, name, marketCapSol } = stats;

  const type = classifyBundle(totalSol,maxSingle);
  const axiom = `https://axiom.trade/t/${mint}`;

  const embed = {
    title:`🎯 ${type} — ${name ?? ""}`,
    description:
      `🧩 Trades: ${trades.length} trong ${windowSec}s\n`+
      `💰 Total: ${totalSol.toFixed(2)} SOL\n`+
      `💣 Biggest: ${maxSingle.toFixed(2)} SOL\n`+
      `📊 Dominance: ${dominancePercent}%\n`+
      `🏷 MarketCap: ~${marketCapSol.toFixed(1)} SOL (~$${(marketCapSol*SOL_PRICE_USD).toFixed(0)})\n`+
      `📜 CA: \`${mint}\`\n\n`,
    color:type==="🐳 80%"?0xff0000:type==="🚀 60%"?0x00ff9d:0xf7a600,
    fields:[{name:"🔗 OPEN",value:`[AXIOM](${axiom})`}],
    timestamp:new Date().toISOString()
  };

  await axios.post(DISCORD_WEBHOOK_URL,{
    content:`@everyone 🔥 **BUNDLE DETECTED** — \`${mint}\``,
    embeds:[embed]
  });

  log(`📩 Alert sent for ${mint}`);
}

function recordTrade(mint,buyer,sol){
  const s = ensureMint(mint);

  s.trades.push({ts:now(),buyer,sol});
  s.trades = s.trades.filter(t=>t.ts>=now()-BUNDLE_WINDOW_MS);

  const totalSol = s.trades.reduce((a,t)=>a+t.sol,0);
  const maxSingle = Math.max(...s.trades.map(t=>t.sol));
  const dominancePercent = ((Math.max(...Object.values(
    s.trades.reduce((m,t)=>((m[t.buyer]=(m[t.buyer]||0)+t.sol),m),{})
  )) / totalSol) * 100).toFixed(1);

  if(s.alerted) return;

  const isBundle = (s.trades.length>=MIN_TRADES && totalSol>=MIN_TOTAL_SOL) || (maxSingle >= BIG_SINGLE_BUY_SOL);

  // ❗ Stop nếu chưa đủ marketcap
  if(isBundle && s.marketCapSol >= MIN_MARKETCAP_SOL){
    s.alerted = true;
    sendAlert(mint,{
      ...s,
      trades:s.trades,
      totalSol,
      maxSingle,
      dominancePercent,
      windowSec:(BUNDLE_WINDOW_MS/1000).toFixed(1)
    });
  }
}

function handleCreate(msg){
  const s = ensureMint(msg.mint);
  s.name = msg.name || msg.symbol;
  s.marketCapSol = msg.marketCapSol || 0;
}

function handleBuy(msg){
  const s = ensureMint(msg.mint);
  s.marketCapSol = msg.marketCapSol ?? s.marketCapSol;

  if(typeof msg.vSolInBondingCurve === "number"){
    const prev = s.lastVSOL ?? msg.vSolInBondingCurve;
    const diff = msg.vSolInBondingCurve - prev;
    if(diff>0) recordTrade(msg.mint,msg.traderPublicKey||msg.trader||"unknown",diff);
    s.lastVSOL = msg.vSolInBondingCurve;
  }
}

function handleGeneric(msg){
  const mint = msg.mint;
  if(!(msg.side==="buy"||msg.is_buy)) return;
  const sol = extractSolGeneric(msg);
  if(sol>0) recordTrade(mint,msg.trader||msg.user||"unknown",sol);
}

function handleMsg(raw){
  let msg; try{msg=JSON.parse(raw);}catch{return;}
  if(!msg.mint) return;

  if(msg.txType==="create") return handleCreate(msg);
  if(msg.txType==="buy") return handleBuy(msg);

  handleGeneric(msg);
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.on("open", ()=>ws.send(JSON.stringify({method:"subscribeNewToken"})));
  ws.on("message",handleMsg);
  ws.on("close",()=>setTimeout(connect,3000));
}

log("🚀 Pump Bundle Watch (with marketcap filter) running...");
connect();
