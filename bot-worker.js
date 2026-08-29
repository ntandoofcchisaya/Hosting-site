/**
 * Bot Worker — runs a SINGLE KnightBot-Mini bot instance as a child process.
 * ------------------------------------------------------------------
 * Spawned by botManager.js via child_process.fork().
 *
 * Receives config via process.env (KB_BOT_ID, KB_CONFIG path) and:
 *   - Builds the Baileys socket from the session creds
 *   - Loads KnightBot-Mini's handler + commands if available
 *   - Falls back to a lightweight standalone handler if the KnightBot-Mini
 *     repo is not present (so the platform still works as a session host)
 *   - Reports status + logs to the parent over IPC
 * ------------------------------------------------------------------
 */

process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const pino = require('pino');

// IPC helpers — talk to parent botManager
function send(type, payload = {}) {
  if (process.send) {
    try { process.send({ type, ...payload, ts: Date.now() }); } catch (_) {}
  }
}
function logToParent(level, msg) {
  const line = typeof msg === 'string' ? msg : (msg?.message || JSON.stringify(msg));
  send('log', { level, line });
}

// Pipe console output to parent so the dashboard can show live logs
const origLog = console.log;
const origErr = console.error;
console.log = (...a) => { const m = a.map(x => typeof x === 'string' ? x : (x?.message || JSON.stringify(x))).join(' '); origLog(...a); logToParent('info', m); };
console.error = (...a) => { const m = a.map(x => typeof x === 'string' ? x : (x?.message || JSON.stringify(x))).join(' '); origErr(...a); logToParent('error', m); };

// --- Read config handed over by the manager ---
const BOT_ID = process.env.KB_BOT_ID;
const CONFIG_PATH = process.env.KB_CONFIG_PATH;
const SESSION_DIR = process.env.KB_SESSION_DIR;

if (!BOT_ID || !CONFIG_PATH || !SESSION_DIR) {
  console.error('Missing KB_BOT_ID / KB_CONFIG_PATH / KB_SESSION_DIR env vars');
  process.exit(1);
}

const botConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// --- Resolve the session string into creds.json in the session dir ---
function setupSession() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  const credsFile = path.join(SESSION_DIR, 'creds.json');

  if (botConfig.sessionID && botConfig.sessionID.startsWith('KnightBot!')) {
    try {
      const [, b64data] = botConfig.sessionID.split('!');
      const cleanB64 = b64data.replace('...', '');
      const compressed = Buffer.from(cleanB64, 'base64');
      const decompressed = zlib.gunzipSync(compressed);
      fs.writeFileSync(credsFile, decompressed, 'utf8');
      console.log('🔌 Session restored from KnightBot! session string');
    } catch (e) {
      console.error('❌ Failed to decode session string:', e.message);
    }
  }
  return credsFile;
}

// --- Try to load the real KnightBot-Mini engine; fall back to lightweight ---
async function startBot() {
  setupSession();
  send('status', { status: 'starting' });

  let handler, config;
  const repoRoot = path.resolve(__dirname, 'knightbot-engine');

  // Build a runtime config object that mirrors KnightBot-Mini's config.js shape
  const runtimeConfig = {
    ownerNumber: botConfig.ownerNumber || [],
    ownerName: botConfig.ownerName || ['Hosted Bot'],
    botName: botConfig.botName || 'Knight Bot Mini',
    prefix: botConfig.prefix || ',',
    sessionName: 'session',
    sessionID: botConfig.sessionID || '',
    packname: botConfig.packname || 'Knight Bot',
    selfMode: !!botConfig.selfMode,
    autoRead: !!botConfig.autoRead,
    autoTyping: !!botConfig.autoTyping,
    autoBio: !!botConfig.autoBio,
    autoReact: !!botConfig.autoReact,
    autoReactMode: 'bot',
    timezone: botConfig.timezone || 'Asia/Kolkata',
    messages: {
      wait: '⏳ Please wait...',
      success: '✅ Success!',
      error: '❌ Error occurred!',
      ownerOnly: '👑 This command is only for bot owner!',
      adminOnly: '🛡️ This command is only for group admins!',
      groupOnly: '👥 This command can only be used in groups!',
      privateOnly: '💬 This command can only be used in private chat!',
      botAdminNeeded: '🤖 Bot needs to be admin to execute this command!',
      invalidCommand: '❓ Invalid command! Type .menu for help',
    },
  };

  // Attempt to use the real KnightBot-Mini handler/commands if cloned into ./knightbot-engine
  try {
    if (fs.existsSync(path.join(repoRoot, 'handler.js')) && fs.existsSync(path.join(repoRoot, 'config.js'))) {
      // Override config.js with the runtime config by writing a temporary config
      const tempConfigPath = path.join(repoRoot, 'config.runtime.js');
      fs.writeFileSync(tempConfigPath, `module.exports = ${JSON.stringify(runtimeConfig, null, 2)};`, 'utf8');
      // Patch require cache so handler loads our runtime config
      const Module = require('module');
      const origResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, parent, ...rest) {
        if (request === './config' && parent?.filename?.startsWith(repoRoot)) {
          return tempConfigPath;
        }
        return origResolve.call(this, request, parent, ...rest);
      };
      handler = require(path.join(repoRoot, 'handler.js'));
      config = runtimeConfig;
      console.log('📦 Loaded KnightBot-Mini engine from ./knightbot-engine');
    } else {
      throw new Error('engine not found');
    }
  } catch (e) {
    console.log('ℹ️ Using lightweight built-in handler (clone KnightBot-Mini into ./knightbot-engine for full commands)');
    handler = require('./liteHandler.js');
    config = runtimeConfig;
  }

  // --- Baileys socket ---
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
  } = require('@whiskeysockets/baileys');

  const logger = pino({ level: 'silent' });
  let sock;
  let reconnectAttempts = 0;
  const MAX_RECONNECT = 10;

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      auth: state,
      syncFullHistory: false,
      downloadHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        reconnectAttempts = 0;
        const number = sock.user?.id?.split(':')[0] || 'unknown';
        send('status', { status: 'online', number, botName: config.botName });
        console.log(`✅ Bot connected! Number: ${number} | Name: ${config.botName} | Prefix: ${config.prefix}`);
        if (config.autoBio) {
          try { await sock.updateProfileStatus(`${config.botName} | Active 24/7`); } catch (_) {}
        }
      } else if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        send('status', { status: shouldReconnect ? 'reconnecting' : 'logged_out' });
        if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          console.log(`⚠️ Connection closed (${code}). Reconnecting (${reconnectAttempts}/${MAX_RECONNECT})...`);
          setTimeout(connect, 3000);
        } else if (code === DisconnectReason.loggedOut) {
          console.log('❌ Session logged out. Please generate a new session string.');
          send('status', { status: 'logged_out' });
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || !msg.key?.id) continue;
        const from = msg.key.remoteJid;
        if (!from || from.includes('@broadcast') || from.includes('status.broadcast') || from.includes('@newsletter')) continue;
        try {
          handler.handleMessage(sock, msg, config).catch((e) => {
            if (!e?.message?.includes('rate-overlimit')) console.error('Handler error:', e.message);
          });
        } catch (e) {
          console.error('Message handling error:', e.message);
        }
      }
    });

    sock.ev.on('group-participants.update', async (update) => {
      if (handler.handleGroupUpdate) {
        try { await handler.handleGroupUpdate(sock, update, config); } catch (_) {}
      }
    });

    if (config.autoRead) {
      sock.ev.on('messages.upsert', async ({ messages }) => {
        try { await sock.readMessages(messages.map(m => m.key)); } catch (_) {}
      });
    }
  }

  // Graceful shutdown from parent
  process.on('message', (msg) => {
    if (msg?.type === 'stop') {
      send('status', { status: 'stopping' });
      try { sock?.end?.(); } catch (_) {}
      setTimeout(() => process.exit(0), 500);
    } else if (msg?.type === 'restart') {
      send('status', { status: 'restarting' });
      try { sock?.end?.(); } catch (_) {}
      setTimeout(connect, 1500);
    }
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught:', err.message);
    send('status', { status: 'error', error: err.message });
  });
  process.on('unhandledRejection', (err) => {
    const m = err?.message || String(err);
    if (!m.includes('rate-overlimit')) console.error('Unhandled rejection:', m);
  });

  console.log(`🚀 Starting bot "${config.botName}" (prefix: ${config.prefix})...`);
  connect().catch((e) => {
    console.error('Fatal start error:', e.message);
    send('status', { status: 'error', error: e.message });
  });
}

startBot();
