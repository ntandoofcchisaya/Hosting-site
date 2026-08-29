/**
 * Bot Manager — multi-tenant bot lifecycle controller.
 * ------------------------------------------------------------------
 *  • Spawns isolated bot-worker.js child processes via child_process.fork()
 *  • Maintains an in-memory process registry:  botId → { proc, status, logs, config, meta }
 *  • Handles start / stop / restart / status / logs
 *  • Monitors process 'exit' and auto-restarts on unexpected crash (up to MAX_RESTARTS)
 *  • Buffers the last N log lines per bot (circular buffer) so the dashboard can show live logs
 *  • Restores previously-running bots from the data store on platform boot
 * ------------------------------------------------------------------
 */

const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const dataStore = require('./dataStore');
const userStore = require('./userStore');

const WORKER_PATH = path.join(__dirname, 'bot-worker.js');
const MAX_LOG_LINES = 200;          // circular buffer size per bot
const MAX_RESTARTS = 5;             // auto-restart cap within window
const RESTART_WINDOW_MS = 60_000;   // 1-minute sliding window

// Coin economy: deduct 1 coin every COIN_TICK_MS of runtime.
// 10 coins/day → 1 coin per (24h/10) = 2.4h → tick = 144 min.
// We use a finer tick for responsiveness: deduct proportional coins every 10 min.
const COIN_TICK_MS = userStore.COIN_TICK_MS;            // 10 min
const COINS_PER_TICK = userStore.COINS_PER_BOT_PER_DAY * (COIN_TICK_MS / userStore.MS_PER_DAY); // ~0.0694 coins/tick

/** registry: Map<botId, BotRuntime> */
const registry = new Map();

/**
 * BotRuntime shape:
 * {
 *   proc:        ChildProcess | null,
 *   status:      'starting' | 'online' | 'reconnecting' | 'stopping' | 'stopped' | 'error' | 'logged_out',
 *   statusDetail:{ phoneNumber?: string, botName?: string, error?: string },
 *   logs:        string[],            // circular buffer
 *   logIdx:      number,
 *   config:      object,
 *   meta:        { ownerToken, name, createdAt },
 *   restartTimes:number[],           // timestamps for restart-window tracking
 *   intentional: boolean             // true when we killed it on purpose (no auto-restart)
 * }
 */

function makeRuntime(bot) {
  return {
    proc: null,
    status: 'stopped',
    statusDetail: {},
    logs: new Array(MAX_LOG_LINES).fill(null),
    logIdx: 0,
    config: bot.config,
    meta: { ownerToken: bot.ownerToken, userId: bot.ownerToken, name: bot.name, id: bot.id },
    restartTimes: [],
    intentional: true,
    coinAccrued: 0,         // fractional coins accrued since last deduction
    runStart: 0,            // timestamp when current run started
  };
}

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

function pushLog(rt, line) {
  rt.logs[rt.logIdx] = line;
  rt.logIdx = (rt.logIdx + 1) % MAX_LOG_LINES;
}

function getLogs(rt, limit = 100) {
  const out = [];
  const len = rt.logs.length;
  // walk backwards from the most-recent entry
  for (let i = 0; i < len && out.length < limit; i++) {
    const idx = (rt.logIdx - 1 - i + len) % len;
    const entry = rt.logs[idx];
    if (entry == null) break;
    out.unshift(entry);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Process spawning                                                   */
/* ------------------------------------------------------------------ */

function spawnWorker(bot) {
  let rt = registry.get(bot.id);
  if (!rt) {
    rt = makeRuntime(bot);
    registry.set(bot.id, rt);
  }

  rt.intentional = false;
  rt.status = 'starting';
  rt.statusDetail = {};

  // Prepare per-bot working directory under /data/bots/<id>/
  const botDataDir = path.join(__dirname, 'data', 'bots', bot.id);
  if (!fs.existsSync(botDataDir)) fs.mkdirSync(botDataDir, { recursive: true });
  const configPath = path.join(botDataDir, 'config.json');
  const sessionDir = path.join(botDataDir, 'session');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  // Write the config the worker will read
  fs.writeFileSync(configPath, JSON.stringify(bot.config || {}, null, 2), 'utf8');

  const env = {
    ...process.env,
    KB_BOT_ID: bot.id,
    KB_BOT_NAME: bot.name || 'KnightBot',
    KB_OWNER_TOKEN: bot.ownerToken,
    KB_CONFIG_PATH: configPath,
    KB_SESSION_DIR: sessionDir,
  };

  pushLog(rt, `[${ts()}] 🚀 Starting bot worker for "${bot.name}" (${bot.id})`);

  const proc = cp.fork(WORKER_PATH, [], {
    env,
    silent: true,            // capture stdout/stderr
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  rt.proc = proc;

  /* ---- stdout / stderr → log buffer ---- */
  proc.stdout && proc.stdout.on('data', d => pushLog(rt, strip(d)));
  proc.stderr && proc.stderr.on('data', d => pushLog(rt, strip(d)));

  /* ---- IPC messages from the worker ---- */
  proc.on('message', msg => handleWorkerMessage(rt, msg));

  /* ---- exit / crash handling ---- */
  proc.on('exit', (code, signal) => {
    pushLog(rt, `[${ts()}] ⛔ Worker exited (code=${code}, signal=${signal || 'none'})`);
    const prevStatus = rt.status;
    rt.proc = null;

    if (prevStatus === 'logged_out') {
      rt.status = 'logged_out';
      rt.intentional = true;
      return;
    }

    if (rt.intentional) {
      rt.status = 'stopped';
      return;
    }

    /* ---- unexpected crash → auto-restart ---- */
    const now = Date.now();
    rt.restartTimes = rt.restartTimes.filter(t => now - t < RESTART_WINDOW_MS);
    if (rt.restartTimes.length >= MAX_RESTARTS) {
      rt.status = 'error';
      rt.statusDetail = { error: 'Max restarts exceeded — bot halted' };
      pushLog(rt, `[${ts()}] ❌ Auto-restart limit reached. Bot marked as error.`);
      return;
    }
    rt.restartTimes.push(now);
    rt.status = 'reconnecting';
    pushLog(rt, `[${ts()}] ♻️  Auto-restarting in 3s… (attempt ${rt.restartTimes.length}/${MAX_RESTARTS})`);
    setTimeout(() => {
      if (rt.intentional) return;     // user stopped during the wait
      const fresh = dataStore.getBot(bot.id);
      if (fresh) spawnWorker(fresh);
    }, 3000);
  });

  proc.on('error', err => {
    pushLog(rt, `[${ts()}] ❌ Process error: ${err.message}`);
    rt.status = 'error';
    rt.statusDetail = { error: err.message };
  });
}

function handleWorkerMessage(rt, msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'status':
      rt.status = msg.status || rt.status;
      rt.statusDetail = msg.detail || {};
      pushLog(rt, `[${ts()}] 📡 Status: ${msg.status}${msg.detail?.phoneNumber ? ' (' + msg.detail.phoneNumber + ')' : ''}`);
      // persist online status
      dataStore.updateBot(rt.meta.id, { lastStatus: msg.status, lastSeen: Date.now() });
      break;
    case 'log':
      pushLog(rt, msg.line || '');
      break;
    case 'logged_out':
      rt.status = 'logged_out';
      rt.intentional = true;
      pushLog(rt, `[${ts()}] 🔓 Bot logged out.`);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/** Start (or re-spawn) a bot instance. */
function startBot(bot) {
  const existing = registry.get(bot.id);
  if (existing && existing.proc) {
    return { ok: false, error: 'Bot is already running' };
  }
  // Coin check: non-admin users need coins to run a bot
  const userId = bot.ownerToken;
  const balance = userStore.getBalance(userId);
  if (balance && !balance.isUnlimited && balance.coins < 1) {
    return { ok: false, error: 'Insufficient coins. You need at least 1 coin to start a bot. 10 coins = 1 bot-day.' };
  }
  spawnWorker(bot);
  const rt = registry.get(bot.id);
  if (rt) rt.runStart = Date.now();
  return { ok: true, status: 'starting' };
}

/** Stop a running bot (intentional — no auto-restart). */
function stopBot(botId) {
  const rt = registry.get(botId);
  if (!rt || !rt.proc) return { ok: false, error: 'Bot is not running' };
  rt.intentional = true;
  rt.status = 'stopping';
  pushLog(rt, `[${ts()}] 🛑 Stop requested.`);
  try { rt.proc.send({ type: 'stop' }); } catch (_) {}
  // hard-kill fallback after 8s
  setTimeout(() => {
    if (rt.proc) {
      pushLog(rt, `[${ts()}] ⚔️ Force-killing worker.`);
      try { rt.proc.kill('SIGKILL'); } catch (_) {}
    }
  }, 8000);
  return { ok: true, status: 'stopping' };
}

/** Restart a bot instance. */
function restartBot(botId) {
  const rt = registry.get(botId);
  if (!rt) return { ok: false, error: 'Bot not found in registry' };
  const bot = dataStore.getBot(botId);
  if (!bot) return { ok: false, error: 'Bot record not found' };
  if (rt.proc) {
    rt.intentional = true;
    rt.status = 'stopping';
    pushLog(rt, `[${ts()}] ♻️  Restart requested.`);
    try { rt.proc.send({ type: 'stop' }); } catch (_) {}
    setTimeout(() => {
      if (rt.proc) try { rt.proc.kill('SIGKILL'); } catch (_) {}
      spawnWorker(bot);
    }, 2500);
  } else {
    spawnWorker(bot);
  }
  return { ok: true, status: 'reconnecting' };
}

/** Get the current status of a bot. */
function getStatus(botId) {
  const rt = registry.get(botId);
  if (!rt) return { ok: true, status: 'stopped', detail: {} };
  return {
    ok: true,
    status: rt.status,
    detail: rt.statusDetail,
    pid: rt.proc ? rt.proc.pid : null,
    uptime: rt.proc ? process.uptime() : 0,
  };
}

/** Get recent log lines for a bot. */
function getBotLogs(botId, limit = 100) {
  const rt = registry.get(botId);
  if (!rt) return { ok: true, logs: [] };
  return { ok: true, logs: getLogs(rt, limit) };
}

/** Remove a bot entirely — stop it first, then drop from registry. */
function removeBot(botId) {
  stopBot(botId);
  registry.delete(botId);
  // clean up per-bot data directory
  const botDataDir = path.join(__dirname, 'data', 'bots', botId);
  if (fs.existsSync(botDataDir)) {
    try { fs.rmSync(botDataDir, { recursive: true, force: true }); } catch (_) {}
  }
  return { ok: true };
}

/** Restore previously-active bots on platform boot. */
function restoreOnBoot() {
  const all = dataStore.listBots();
  let restored = 0;
  for (const bot of all) {
    if (bot.autoStart !== false && bot.config && bot.config.sessionId) {
      const rt = makeRuntime(bot);
      registry.set(bot.id, rt);
      // stagger spawns to avoid thundering herd
      setTimeout(() => spawnWorker(bot), restored * 1200);
      restored++;
    }
  }
  if (restored) console.log(`[botManager] Restored ${restored} bot(s) on boot.`);
  return restored;
}

/** List runtime summaries for all bots belonging to an owner. */
function listRuntimeForOwner(ownerToken) {
  const bots = dataStore.listBots(ownerToken);
  return bots.map(b => {
    const rt = registry.get(b.id);
    return {
      id: b.id,
      name: b.name,
      status: rt ? rt.status : 'stopped',
      detail: rt ? rt.statusDetail : {},
      createdAt: b.createdAt,
      lastSeen: b.lastSeen,
      autoStart: b.autoStart !== false,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Coin economy — periodic deduction + auto-stop on zero balance      */
/* ------------------------------------------------------------------ */

/**
 * Every COIN_TICK_MS, for each running bot we accrue COINS_PER_TICK
 * against the owner's balance. Admins (isUnlimited) are skipped.
 * If a non-admin runs out of coins, their bots are auto-stopped.
 */
function coinTick() {
  for (const [botId, rt] of registry.entries()) {
    if (!rt.proc) continue;
    if (['stopping', 'stopped', 'error', 'logged_out'].includes(rt.status)) continue;

    const userId = rt.meta.userId;
    const balance = userStore.getBalance(userId);
    if (!balance) continue;

    // Admin / unlimited users pay nothing
    if (balance.isUnlimited) {
      rt.coinAccrued = 0;
      continue;
    }

    // Accrue fractional coins
    rt.coinAccrued += COINS_PER_TICK;

    // When we've accrued at least 1 whole coin, deduct it
    if (rt.coinAccrued >= 1) {
      const toDeduct = Math.floor(rt.coinAccrued);
      rt.coinAccrued -= toDeduct;
      userStore.updateCoins(userId, -toDeduct);
      pushLog(rt, `[${ts()}] 🪙 Coin deduction: -${toDeduct} (runtime cost)`);

      // Check if balance hit zero → stop the bot
      const after = userStore.getBalance(userId);
      if (after && !after.isUnlimited && after.coins <= 0) {
        pushLog(rt, `[${ts()}] ⛔ Out of coins — stopping bot. Top up to resume.`);
        stopBot(botId);
      }
    }
  }
}

// Start the coin ticker
setInterval(coinTick, COIN_TICK_MS);

/** Estimate remaining runtime for a user given their balance + running bots. */
function estimateRuntime(userId) {
  const balance = userStore.getBalance(userId);
  if (!balance) return { coins: 0, botDays: 0, unlimited: false };
  if (balance.isUnlimited) return { coins: 'unlimited', botDays: 'unlimited', unlimited: true };
  const runningCount = countRunningBotsForOwner(userId);
  if (runningCount === 0) {
    return { coins: balance.coins, botDays: balance.coins / userStore.COINS_PER_BOT_PER_DAY, unlimited: false };
  }
  // coins / (cost per day per bot * number of bots)
  const botDays = balance.coins / (userStore.COINS_PER_BOT_PER_DAY * runningCount);
  return { coins: balance.coins, botDays: +(botDays.toFixed(2)), unlimited: false, runningBots: runningCount };
}

function countRunningBotsForOwner(ownerToken) {
  let n = 0;
  for (const rt of registry.values()) {
    if (rt.meta.ownerToken === ownerToken && rt.proc && ['online', 'starting', 'reconnecting'].includes(rt.status)) {
      n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function strip(d) {
  return d.toString().replace(/\n$/, '');
}

module.exports = {
  startBot,
  stopBot,
  restartBot,
  getStatus,
  getBotLogs,
  removeBot,
  restoreOnBoot,
  listRuntimeForOwner,
  estimateRuntime,
  // exposed for tests / debugging
  _registry: registry,
};
