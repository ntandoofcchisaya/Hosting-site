/**
 * KnightBot-Mini Multi-Hosting Server
 * ---------------------------------------------------------------
 * Serves:
 *   • Static hosting site (landing page, dashboard, config builder)
 *   • Pair-code generator API  (/api/pair/*)
 *   • Render deploy blueprint   (/api/deploy/render)
 *   • Multi-tenant bot management API  (/api/bots/*)
 *
 * Users create bot instances (each = one WhatsApp session), manage
 * them from the dashboard (start/stop/restart/view logs), and the
 * platform runs each bot as an isolated child process via botManager.
 *
 * Designed to run on Render (Web Service) out of the box.
 * ---------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const dataStore = require('./dataStore');
const botManager = require('./botManager');
const userStore = require('./userStore');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware -----------------------------------------------------------
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// --- In-memory pair-session registry --------------------------------------
// Each entry: { id, phone, status, pairCode, sessionString, createdAt, sock }
const sessions = new Map();
const SESSION_TTL = 6 * 60 * 1000; // 6 minutes before auto-cleanup

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions.entries()) {
    if (now - entry.createdAt > SESSION_TTL) {
      try { entry.sock?.end?.(); } catch (_) {}
      sessions.delete(id);
      cleanupSessionFolder(id);
    }
  }
}, 60 * 1000);

// --- Helpers --------------------------------------------------------------
const authDir = (id) => path.join(os.tmpdir(), `kb_auth_${id}`);

function cleanupSessionFolder(id) {
  const dir = authDir(id);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function buildSessionString(credsPath) {
  if (!fs.existsSync(credsPath)) return null;
  const raw = fs.readFileSync(credsPath);
  const gz = zlib.gzipSync(raw);
  const b64 = gz.toString('base64');
  return `KnightBot!${b64}...`;
}

async function createSocket(id, phone) {
  const dir = authDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    auth: state,
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
  });

  const entry = sessions.get(id);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      const credsPath = path.join(dir, 'creds.json');
      setTimeout(() => {
        const sessionString = buildSessionString(credsPath);
        if (entry) {
          entry.status = 'connected';
          entry.sessionString = sessionString;
        }
      }, 800);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (entry && code === DisconnectReason.loggedOut) {
        entry.status = 'logged_out';
        cleanupSessionFolder(id);
      } else if (shouldReconnect && entry && entry.status !== 'connected') {
        setTimeout(() => {
          if (sessions.has(id) && sessions.get(id).status !== 'connected') {
            createSocket(id, phone).catch(() => {});
          }
        }, 2000);
      }
    }
  });

  if (phone && !state.creds.registered) {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const code = await sock.requestPairingCode(phone);
      if (entry) {
        entry.pairCode = code;
        entry.status = 'pairing';
      }
    } catch (err) {
      if (entry) entry.status = 'error';
    }
  }

  if (entry) entry.sock = sock;
  return sock;
}

/* ============================================================= */
/*  Health & pair-code routes                                     */
/* ============================================================= */

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    pairSessions: sessions.size,
    activeBots: botManager._registry.size,
  });
});

app.post('/api/pair/request', async (req, res) => {
  try {
    let { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
    phone = String(phone).replace(/[^0-9]/g, '');
    if (phone.length < 8 || phone.length > 15) {
      return res.status(400).json({ error: 'Please enter a valid phone number with country code (digits only).' });
    }
    const id = crypto.randomBytes(8).toString('hex');
    sessions.set(id, {
      id, phone, status: 'pending', pairCode: null,
      sessionString: null, createdAt: Date.now(), sock: null,
    });
    createSocket(id, phone).catch(() => {
      const entry = sessions.get(id);
      if (entry) entry.status = 'error';
    });
    res.json({ sessionId: id, status: 'pending', message: 'Pairing session started. Poll /api/pair/status to get your code.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start pairing session.', detail: err.message });
  }
});

app.get('/api/pair/status', (req, res) => {
  const { sessionId } = req.query;
  const entry = sessions.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'Session not found or expired.' });
  const response = {
    sessionId: entry.id, phone: entry.phone, status: entry.status,
    pairCode: entry.pairCode, sessionString: entry.sessionString,
  };
  if (entry.status === 'connected' && entry.sessionString) {
    setTimeout(() => {
      try { entry.sock?.end?.(); } catch (_) {}
      sessions.delete(sessionId);
      cleanupSessionFolder(entry.id);
    }, 15_000);
  }
  res.json(response);
});

app.post('/api/deploy/render', (req, res) => {
  const yaml = `services:
  - type: web
    name: knightbot-mini
    runtime: node
    plan: free
    region: oregon
    branch: main
    repo: https://github.com/mruniquehacker/KnightBot-Mini
    buildCommand: npm install
    startCommand: node index.js
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: SESSION_ID
        sync: false
      - key: RENDER
        value: "true"
`;
  res.type('text/yaml').send(yaml);
});

/* ============================================================= */
/*  AUTH SYSTEM — user accounts, sessions, coins, admin           */
/* ============================================================= */

function getAuthToken(req) {
  return (req.headers['x-auth-token'] || req.headers['x-owner-token'] || req.body?.authToken || req.body?.ownerToken || req.query.token || '').trim();
}

/** Resolve the authenticated user from the request, or null. */
function authUser(req) {
  const token = getAuthToken(req);
  return token ? userStore.findByToken(token) : null;
}

/** Middleware: require a logged-in user. */
function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required. Please log in.' });
  req.user = user;
  next();
}

/** Middleware: require admin. */
function requireAdmin(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  if (!user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  req.user = user;
  next();
}

/** Legacy compat: ownerToken now maps to user.id. */
function getOwnerToken(req) {
  const user = authUser(req);
  return user ? user.id : '';
}

/* ---- Auth routes ---- */

/** POST /api/auth/register — free account creation */
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = userStore.createUser(username, password);
    const token = userStore.createSession(user);
    res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, coins: user.coins, isAdmin: user.isAdmin, isUnlimited: user.isUnlimited },
    });
  } catch (err) {
    // 409 Conflict for duplicate username, 400 for other validation errors
    const status = err.message.includes('already taken') ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

/** POST /api/auth/login */
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const user = userStore.findByUsername(String(username).trim().toLowerCase());
    if (!user || !userStore.verifyPassword(user, password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = userStore.createSession(user);
    res.json({
      ok: true,
      token,
      user: { id: user.id, username: user.username, coins: user.coins, isAdmin: user.isAdmin, isUnlimited: user.isUnlimited },
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed.', detail: err.message });
  }
});

/** POST /api/auth/logout */
app.post('/api/auth/logout', (req, res) => {
  const token = getAuthToken(req);
  userStore.destroySession(token);
  res.json({ ok: true });
});

/** GET /api/auth/me — current user profile + coin balance */
app.get('/api/auth/me', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  const est = botManager.estimateRuntime(user.id);
  res.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      coins: user.coins,
      isAdmin: user.isAdmin,
      isUnlimited: user.isUnlimited,
      createdAt: user.createdAt,
    },
    economy: {
      coinsPerBotPerDay: userStore.COINS_PER_BOT_PER_DAY,
      starterCoins: userStore.STARTER_COINS,
      estimate: est,
    },
  });
});

/* ---- Coin routes ---- */

/** GET /api/coins/balance */
app.get('/api/coins/balance', requireAuth, (req, res) => {
  const est = botManager.estimateRuntime(req.user.id);
  res.json({
    ok: true,
    coins: req.user.coins,
    isUnlimited: req.user.isUnlimited,
    estimate: est,
  });
});

/* ---- Admin routes ---- */

/** GET /api/admin/users — list all users */
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ ok: true, users: userStore.listAllUsers() });
});

/** POST /api/admin/users/:id/coins — grant/set coins to a user */
app.post('/api/admin/users/:id/coins', requireAdmin, (req, res) => {
  const { amount, action = 'add' } = req.body || {};
  const amt = parseInt(amount, 10);
  if (isNaN(amt)) return res.status(400).json({ error: 'amount must be a number.' });
  const target = userStore.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  let updated;
  if (action === 'set') {
    updated = userStore.setCoins(target.id, amt);
  } else {
    updated = userStore.updateCoins(target.id, amt);
  }
  res.json({ ok: true, user: { id: updated.id, username: updated.username, coins: updated.coins, isUnlimited: updated.isUnlimited } });
});

/** POST /api/admin/users/:id/unlimited — toggle unlimited coins */
app.post('/api/admin/users/:id/unlimited', requireAdmin, (req, res) => {
  const target = userStore.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const updated = userStore.updateUser(target.id, { isUnlimited: !!req.body.unlimited });
  res.json({ ok: true, user: { id: updated.id, username: updated.username, isUnlimited: updated.isUnlimited } });
});

/** GET /api/admin/bots — list ALL bots across all users */
app.get('/api/admin/bots', requireAdmin, (_req, res) => {
  const allBots = dataStore.listBots();
  const enriched = allBots.map(b => {
    const status = botManager.getStatus(b.id);
    const owner = userStore.findById(b.ownerToken);
    return {
      id: b.id,
      name: b.name,
      ownerToken: b.ownerToken,
      ownerUsername: owner ? owner.username : 'unknown',
      status: status.status,
      detail: status.detail,
      createdAt: b.createdAt,
      autoStart: b.autoStart !== false,
    };
  });
  res.json({ ok: true, bots: enriched });
});

/** DELETE /api/admin/bots/:id — admin can delete any bot */
app.delete('/api/admin/bots/:id', requireAdmin, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  botManager.removeBot(req.params.id);
  dataStore.deleteBot(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /api/admin/install-repo — clone a GitHub repo as the bot engine.
 * Body: { repoUrl: "https://github.com/user/repo.git" }
 * Clones into ./knightbot-engine so bot-worker.js loads it.
 */
app.post('/api/admin/install-repo', requireAdmin, (req, res) => {
  const { repoUrl } = req.body || {};
  if (!repoUrl || !/^https?:\/\/github\.com\//.test(repoUrl)) {
    return res.status(400).json({ error: 'A valid GitHub repo URL is required (https://github.com/...).' });
  }
  const target = path.join(__dirname, 'knightbot-engine');
  try {
    // Remove existing engine dir if present
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    // Clone the repo (shallow, depth 1 for speed)
    const cmd = `git clone --depth 1 "${repoUrl}" "${target}" 2>&1`;
    const output = execSync(cmd, { timeout: 120000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    // Install the engine's dependencies if it has a package.json
    if (fs.existsSync(path.join(target, 'package.json'))) {
      try {
        execSync('npm install --omit=dev --no-audit --no-fund', { cwd: target, timeout: 180000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        // non-fatal — engine may not need extra deps
      }
    }

    res.json({
      ok: true,
      message: 'Bot engine installed successfully from GitHub.',
      repoUrl,
      path: target,
      output: output.slice(-500),
    });
  } catch (err) {
    // Clean up partial clone
    if (fs.existsSync(target)) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    }
    res.status(500).json({ error: 'Failed to install repo.', detail: err.message });
  }
});

/** GET /api/admin/repo-status — check if an engine repo is installed */
app.get('/api/admin/repo-status', requireAdmin, (_req, res) => {
  const target = path.join(__dirname, 'knightbot-engine');
  const installed = fs.existsSync(target) && fs.existsSync(path.join(target, 'package.json'));
  let info = { installed: false };
  if (installed) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
      info = { installed: true, name: pkg.name, version: pkg.version, path: target };
    } catch (_) {
      info = { installed: true, path: target };
    }
  }
  res.json({ ok: true, ...info });
});

/** DELETE /api/admin/repo — remove the installed engine */
app.delete('/api/admin/repo', requireAdmin, (_req, res) => {
  const target = path.join(__dirname, 'knightbot-engine');
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  res.json({ ok: true, message: 'Engine repo removed.' });
});

/* ============================================================= */
/*  MULTI-HOSTING BOT MANAGEMENT API  (/api/bots/*)               */
/*  (now auth-gated — ownerToken = user.id)                       */
/* ============================================================= */

app.post('/api/bots/create', requireAuth, (req, res) => {
  try {
    const { name, sessionId, config = {}, autoStart = true } = req.body || {};

    if (!sessionId || !sessionId.startsWith('KnightBot!')) {
      return res.status(400).json({ error: 'A valid KnightBot! session string is required. Use the pair-code generator to obtain one.' });
    }
    if (!name || name.trim().length < 2) {
      return res.status(400).json({ error: 'Please give your bot a name (min 2 characters).' });
    }

    // Coin check if auto-starting
    if (autoStart) {
      const balance = userStore.getBalance(req.user.id);
      if (balance && !balance.isUnlimited && balance.coins < 1) {
        return res.status(402).json({ error: 'Insufficient coins. You need at least 1 coin to start a bot. 10 coins = 1 bot-day. Ask an admin for more coins.' });
      }
    }

    const bot = dataStore.createBot({
      ownerToken: req.user.id,
      name: name.trim(),
      config: {
        sessionId,
        prefix: config.prefix || ',',
        ownerNumber: config.ownerNumber || '',
        ownerName: config.ownerName || ['Admin'],
        botName: config.botName || name.trim(),
        selfMode: config.selfMode ?? false,
        autoReact: config.autoReact ?? false,
        autoStatusSave: config.autoStatusSave ?? false,
        readMessage: config.readMessage ?? false,
        ...config,
      },
      autoStart,
    });

    if (autoStart) {
      const result = botManager.startBot(bot);
      if (!result.ok) {
        return res.status(402).json({ error: result.error, bot: { id: bot.id, name: bot.name } });
      }
    }

    res.json({ ok: true, bot: { id: bot.id, name: bot.name, createdAt: bot.createdAt } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create bot.', detail: err.message });
  }
});

app.get('/api/bots', requireAuth, (req, res) => {
  const bots = botManager.listRuntimeForOwner(req.user.id);
  const est = botManager.estimateRuntime(req.user.id);
  res.json({ ok: true, bots, economy: est });
});

app.get('/api/bots/:id', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  const status = botManager.getStatus(req.params.id);
  res.json({ ok: true, bot, status });
});

app.delete('/api/bots/:id', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  botManager.removeBot(req.params.id);
  dataStore.deleteBot(req.params.id);
  res.json({ ok: true });
});

app.post('/api/bots/:id/start', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  const result = botManager.startBot(bot);
  if (!result.ok && result.error && result.error.includes('coin')) {
    return res.status(402).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/bots/:id/stop', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  res.json(botManager.stopBot(req.params.id));
});

app.post('/api/bots/:id/restart', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  res.json(botManager.restartBot(req.params.id));
});

app.get('/api/bots/:id/status', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  res.json(botManager.getStatus(req.params.id));
});

app.get('/api/bots/:id/logs', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
  res.json(botManager.getBotLogs(req.params.id, limit));
});

app.patch('/api/bots/:id', requireAuth, (req, res) => {
  const bot = dataStore.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Bot not found.' });
  if (bot.ownerToken !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Not your bot.' });
  const patch = {};
  if (req.body.name) patch.name = String(req.body.name).trim();
  if (req.body.autoStart !== undefined) patch.autoStart = !!req.body.autoStart;
  if (req.body.config) {
    patch.config = { ...bot.config, ...req.body.config };
    if (req.body.config.sessionId && !req.body.config.sessionId.startsWith('KnightBot!')) {
      return res.status(400).json({ error: 'Invalid session string.' });
    }
  }
  const updated = dataStore.updateBot(req.params.id, patch);
  res.json({ ok: true, bot: { id: updated.id, name: updated.name, autoStart: updated.autoStart } });
});

/* ============================================================= */
/*  SPA fallback                                                  */
/* ============================================================= */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  let page = 'index.html';
  if (req.path.startsWith('/dashboard')) page = 'dashboard.html';
  else if (req.path.startsWith('/auth')) page = 'auth.html';
  else if (req.path.startsWith('/admin')) page = 'admin.html';
  const file = path.join(__dirname, 'public', page);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Boot -----------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`KnightBot-Mini multi-hosting server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  // Seed admin account
  try { userStore.seedAdmin(); } catch (e) { console.error('Admin seed failed:', e.message); }
  // Restore any bots that were running before a restart
  try {
    const restored = botManager.restoreOnBoot();
    if (restored) console.log(`Restored ${restored} bot(s) from data store.`);
  } catch (err) {
    console.error('Failed to restore bots:', err.message);
  }
});
