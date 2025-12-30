// pump-bundle-watch.optimized.js
const WebSocket = require("ws");
const axios = require("axios");

// ================= CONFIG =================
const DISCORD_WEBHOOK_URL = "YOUR_WEBHOOK";
const WS_URL = "wss://pumpportal.fun/api/data";

// Detection tuning
const BUNDLE_WINDOW_MS = 3000;
const MIN_TRADES = 2;
const MIN_TOTAL_SOL = 5;
const BIG_SINGLE_BUY_SOL = 4;

// Marketcap filter
const SOL_PRICE_USD = 120;
const MIN_MARKETCAP_USD = 30000;
const MIN_MARKETCAP_SOL = MIN_MARKETCAP_USD / SOL_PRICE_USD;

// Memory control
const MINT_TTL_MS = 2 * 60 * 1000; // 2 phút không activity là xoá
const CLEANUP_INTERVAL_MS = 30 * 1000;

// ================= STATE =================
const perMint = Object.create(null);
let ws = null;

function now() { return Date.now(); }

// ================= HELPERS =================
function ensureMint(m) {
  return perMint[m] ??= {
    lastTs: now(),
    lastVSOL: 0,
    trades: [],
    alerted: false,
    marketCapSol: 0,
    subscribed: false,
    name: ""
  };
}

function estimateMarketCapSol(msg, prev = 0) {
  if (msg.marketCapSol) return msg.marketCapSol;
  if (msg.marketCapUsd) return msg.marketCapUsd / SOL_PRICE_USD;
  if (msg.marketCap) return msg.marketCap / SOL_PRICE_USD;
  if (msg.vSolInBondingCurve) return msg.vSolInBondingCurve * 2;
  return prev;
}

function extractSol(msg) {
  if (msg.solAmount) return msg.solAmount;
  if (msg.sol) return msg.sol;
  if (msg.lamports) return msg.lamports / 1e9;
  if (msg.amount) return msg.amount > 1e6 ? msg.amount / 1e9 : msg.amount;
  return 0;
}

function classify(total, max) {
  if (max >= 15) return "🐳 80%";
  if (max >= 8 || total >= 12) return "🚀 60%";
  if (total >= 5) return "🧨 50%";
  return "📌 BUNDLE";
}

// ================= ALERT =================
async function sendAlert(mint, s, totalSol, maxSingle, dominance) {
  const type = classify(totalSol, maxSingle);

  await axios.post(DISCORD_WEBHOOK_URL, {
    content: `@everyone 🔥 **BUNDLE DETECTED** — \`${mint}\``,
    embeds: [{
      title: `🎯 ${type} — ${s.name}`,
      description:
        `🧩 Trades: ${s.trades.length}\n` +
        `💰 Total: ${totalSol.toFixed(2)} SOL\n` +
        `💣 Biggest: ${maxSingle.toFixed(2)} SOL\n` +
        `📊 Dominance: ${dominance}%\n` +
        `🏷 MC: ~${s.marketCapSol.toFixed(1)} SOL (~$${(s.marketCapSol * SOL_PRICE_USD).toFixed(0)})\n` +
        `📜 CA: \`${mint}\``,
      color: 0xf7a600,
      timestamp: new Date().toISOString(),
      fields: [{ name: "🔗 OPEN", value: `https://axiom.trade/t/${mint}` }]
    }]
  });
}

// ================= CORE =================
function recordTrade(mint, buyer, sol) {
  const s = ensureMint(mint);
  const ts = now();
  s.lastTs = ts;

  s.trades.push([ts, buyer, sol]);

  const cutoff = ts - BUNDLE_WINDOW_MS;
  while (s.trades.length && s.trades[0][0] < cutoff) {
    s.trades.shift();
  }

  if (s.alerted) return;

  let total = 0;
  let maxSingle = 0;
  const buyerMap = Object.create(null);

  for (const [, b, v] of s.trades) {
    total += v;
    maxSingle = Math.max(maxSingle, v);
    buyerMap[b] = (buyerMap[b] || 0) + v;
  }

  const maxBuyer = Math.max(...Object.values(buyerMap));
  const dominance = ((maxBuyer / total) * 100).toFixed(1);

  const isBundle =
    (s.trades.length >= MIN_TRADES && total >= MIN_TOTAL_SOL) ||
    maxSingle >= BIG_SINGLE_BUY_SOL;

  if (isBundle && s.marketCapSol >= MIN_MARKETCAP_SOL) {
    s.alerted = true;
    sendAlert(mint, s, total, maxSingle, dominance);
  }
}

// ================= WS HANDLERS =================
function handleCreate(msg) {
  const s = ensureMint(msg.mint);
  s.name = msg.name || msg.symbol || "";
  s.marketCapSol = estimateMarketCapSol(msg, s.marketCapSol);

  if (!s.subscribed && ws?.readyState === 1) {
    ws.send(JSON.stringify({
      method: "subscribeTokenTrade",
      keys: [msg.mint]
    }));
    s.subscribed = true;
  }
}

function handleBuy(msg) {
  const s = ensureMint(msg.mint);
  s.marketCapSol = estimateMarketCapSol(msg, s.marketCapSol);
  s.lastTs = now();

  if (msg.vSolInBondingCurve != null) {
    const diff = msg.vSolInBondingCurve - s.lastVSOL;
    if (diff > 0) recordTrade(msg.mint, msg.traderPublicKey || "unk", diff);
    s.lastVSOL = msg.vSolInBondingCurve;
  } else {
    const sol = extractSol(msg);
    if (sol > 0) recordTrade(msg.mint, msg.trader || "unk", sol);
  }
}

function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg.mint) return;

  if (msg.txType === "create") handleCreate(msg);
  else if (msg.txType === "buy") handleBuy(msg);
}

// ================= CLEANUP =================
setInterval(() => {
  const t = now();
  for (const mint in perMint) {
    if (t - perMint[mint].lastTs > MINT_TTL_MS) {
      delete perMint[mint];
    }
  }
}, CLEANUP_INTERVAL_MS);

// ================= CONNECT =================
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", handleMsg);
  ws.on("close", () => setTimeout(connect, 3000));
}

connect();