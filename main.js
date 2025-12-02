// pump-bundle-watch.js
// 🛰 Pump.fun Bundle Radar (watch-only, không trade)

const WebSocket = require("ws");
const axios = require("axios");

// ================== CONFIG ==================
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1445037632638947371/ivpVM-yYXgZns66PiwtSRlcgHBjrFAEgfdxW2koOvchceiS4wsSL3RaGdk1TEkI20HF1";
const WS_URL = "wss://pumpportal.fun/api/data";

const BUNDLE_WINDOW_MS = 2000;
const MIN_TRADES = 2;
const MIN_TOTAL_SOL = 30;
const BIG_SINGLE_BUY_SOL = 15;

const DEBUG_TRADES = true;
const DEBUG_RAW_LIMIT = 10;

// ================== STATE ==================
const perMint = {};
let ws = null;
let debugRawCount = 0;

function now() {
  return Date.now();
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function ensureMintState(mint) {
  if (!perMint[mint]) {
    perMint[mint] = {
      createdAt: now(),
      lastVSOL: null,
      trades: [],
      alerted: false,
    };
  }
  return perMint[mint];
}

// ================== UTILS ==================
function extractSolGeneric(event) {
  if (typeof event.solAmount === "number" && event.solAmount > 0) return event.solAmount;
  if (typeof event.sol === "number" && event.sol > 0) return event.sol;
  if (typeof event.lamports === "number" && event.lamports > 0) return event.lamports / 1e9;
  if (typeof event.amount === "number" && event.amount > 0) return event.amount > 1e6 ? event.amount / 1e9 : event.amount;
  if (typeof event.value === "number" && event.value > 0) return event.value;
  return 0;
}

function classifyBundle(trades, totalSol, maxSingleSol) {
  if (maxSingleSol >= BIG_SINGLE_BUY_SOL) return "🐳 80%";
  if (trades.length >= 10 || totalSol >= 10) return "🚀 60%";
  if (totalSol >= 5) return "🧨 50%";
  return "📌 BUNDLE";
}

async function sendAlert(mint, stats) {
  const { trades, totalSol, maxSingleSol, dominancePercent, windowSec, createdAt, name } = stats;

  const bundleType = classifyBundle(trades, totalSol, maxSingleSol);

  const axiomLink = `https://axiom.trade/t/${mint}`;

  const desc =
    `🧩 **Trades:** ${trades.length} trong ~${windowSec}s\n` +
    `💰 **Tổng ước tính:** ${totalSol.toFixed(3)} SOL\n` +
    `💣 **Biggest single buy:** ~${maxSingleSol.toFixed(3)} SOL\n` +
    `📊 **Dominance:** ~${dominancePercent}%\n` +
    `📜 **CA:** \`${mint}\`\n` +
    `⏱ Age: ${createdAt ? `${Math.round((now() - createdAt) / 1000)}s` : "unknown"}`;

  const embed = {
    title: `🎯 BUNDLE DETECTED – ${bundleType} — ${name ?? ""}`,
    description: desc,
    color:
      bundleType === "🐳 80%"
        ? 0xff0000
        : bundleType === "🚀 60%"
        ? 0x00ff9d
        : 0xf7a600,
    fields: [
      {
        name: "🔗 OPEN",
        value: `[💥 **AXIOM** 💥](${axiomLink})`,
      },
    ],
    timestamp: new Date().toISOString(),
  };

  await axios.post(DISCORD_WEBHOOK_URL, {
    content: `@everyone 🔥 **BUNDLE DETECTED** — \`${mint}\``,
    embeds: [embed],
  });

  log(`📩 Alert sent for mint ${mint}`);
}

// ================== CORE BUNDLE LOGIC ==================
function recordTrade(mint, buyer, deltaSol) {
  const s = ensureMintState(mint);

  const t = { ts: now(), buyer, deltaSol };
  s.trades.push(t);

  const cutoff = t.ts - BUNDLE_WINDOW_MS;
  s.trades = s.trades.filter((x) => x.ts >= cutoff);

  const trades = s.trades;
  const totalSol = trades.reduce((sum, x) => sum + (x.deltaSol || 0), 0);
  const maxSingleSol = trades.reduce((m, x) => (x.deltaSol > m ? x.deltaSol : m), 0);

  if (DEBUG_TRADES) {
    log(`TRADE mint=${mint} | buyer=${buyer.slice(0,4)}... | delta≈${deltaSol.toFixed(4)} | trades=${trades.length} | total≈${totalSol.toFixed(3)}`);
  }

  if (s.alerted) return;

  const agg = {};
  for (const x of trades) agg[x.buyer] = (agg[x.buyer] || 0) + (x.deltaSol || 0);

  const maxBuyerSol = Object.values(agg).reduce((m, v) => (v > m ? v : m), 0);
  const dominancePercent = totalSol > 0 ? ((maxBuyerSol / totalSol) * 100).toFixed(1) : 0;

  if (trades.length >= MIN_TRADES && totalSol >= MIN_TOTAL_SOL || maxSingleSol >= BIG_SINGLE_BUY_SOL) {
    s.alerted = true;
    log(`🎯 DETECTED mint=${mint}`);

    sendAlert(mint, {
      ...s,
      trades,
      totalSol,
      maxSingleSol,
      dominancePercent,
      windowSec: (BUNDLE_WINDOW_MS / 1000).toFixed(1),
      createdAt: s.createdAt,
    }).catch(() => {});
  }
}

// ---------- WebSocket Handlers ----------
function handleCreatePortal(msg) {
  const mint = msg.mint;
  if (!mint) return;
  const s = ensureMintState(mint);
  s.createdAt = now();
  s.trades = [];
  s.alerted = false;
  s.name = msg.name || msg.symbol || msg.ticker || null;

  ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
}

function handleBuyPortal(msg) {
  const mint = msg.mint;
  if (!mint) return;
  const s = ensureMintState(mint);
  if (typeof msg.vSolInBondingCurve === "number") {
    const diff = msg.vSolInBondingCurve - (s.lastVSOL ?? msg.vSolInBondingCurve);
    if (diff > 0) recordTrade(mint, msg.traderPublicKey || msg.trader || "unknown", diff);
    s.lastVSOL = msg.vSolInBondingCurve;
  }
}

function handleGenericTrade(msg) {
  const mint = msg.mint || msg.token || msg.ca;
  if (!mint) return;

  if (!(msg.side === "buy" || msg.is_buy)) return;

  const buyer = msg.traderPublicKey || msg.trader || msg.user || "unknown";
  const sol = extractSolGeneric(msg);
  if (sol > 0) recordTrade(mint, buyer, sol);
}

function handleMessage(data) {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }

  if (!msg.mint) return;

  if (msg.txType) {
    if (msg.txType.toLowerCase() === "create") return handleCreatePortal(msg);
    if (msg.txType.toLowerCase() === "buy") return handleBuyPortal(msg);
    return;
  }

  handleGenericTrade(msg);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("✅ WS connected → subscribeNewToken");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
  });

  ws.on("message", handleMessage);
  ws.on("close", () => setTimeout(connect, 3000));
  ws.on("error", () => {});
}

log("🚀 Pump.fun Bundle Watch starting...");
connect();

