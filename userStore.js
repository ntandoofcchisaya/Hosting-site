/**
 * User Store — accounts, coins, and admin management.
 * ------------------------------------------------------------------
 *  • JSON file DB at /data/users.json
 *  • Passwords hashed with SHA-256 + per-user salt (no plaintext)
 *  • Seeded admin account on first boot:
 *      username: "ntando"   password: "ntandoooe"
 *  • Free account creation (new users get STARTER_COINS)
 *  • Admin users have unlimited coins (isUnlimited flag)
 *  • Coin economy: bots cost COINS_PER_BOT_PER_DAY per day of runtime
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

/* ---- Economy constants ---- */
const STARTER_COINS = 50;            // free coins on account creation
const COINS_PER_BOT_PER_DAY = 10;    // 10 coins = 1 bot for 1 day
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const COIN_TICK_MS = 10 * 60 * 1000; // deduct every 10 min of runtime

/* ---- Admin seed ---- */
const ADMIN_USERNAME = 'ntando';
const ADMIN_PASSWORD = 'ntandoooe';

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDir();
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function writeAll(users) {
  ensureDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

/* ---- Password hashing ---- */
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/* ---- Session tokens ---- */
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

/* ---- Persistent admin token (survives ephemeral filesystem restarts) ---- */
/* Derives a deterministic token from the admin password so the admin always
   has a valid session even after Render restarts wipe data/users.json.       */
function makeAdminToken() {
  return 'adm_' + crypto.createHash('sha256').update(ADMIN_PASSWORD + ':persistent').digest('hex');
}

/* Public accessor for the persistent admin token (used by login route). */
function getAdminToken() {
  return makeAdminToken();
}

/* ---- Seed admin on boot ---- */
function seedAdmin() {
  const users = readAll();
  if (users.some(u => u.username === ADMIN_USERNAME)) {
    // Ensure the persistent admin session always exists (survives restarts)
    const adminUser = users.find(u => u.username === ADMIN_USERNAME);
    const adminToken = makeAdminToken();
    if (!adminUser.sessions) adminUser.sessions = [];
    if (!adminUser.sessions.some(s => s.token === adminToken)) {
      adminUser.sessions.push({ token: adminToken, expires: Date.now() + 365 * MS_PER_DAY, createdAt: Date.now() });
      writeAll(users);
    }
    return;
  }
  const salt = makeSalt();
  const adminToken = makeAdminToken();
  users.push({
    id: 'usr_admin',
    username: ADMIN_USERNAME,
    passwordHash: hashPassword(ADMIN_PASSWORD, salt),
    salt,
    coins: 0,
    isUnlimited: true,      // admin = unlimited coins
    isAdmin: true,
    createdAt: Date.now(),
    sessions: [
      { token: adminToken, expires: Date.now() + 365 * MS_PER_DAY, createdAt: Date.now() },
    ],
  });
  writeAll(users);
  console.log(`[userStore] Seeded admin account: ${ADMIN_USERNAME}`);
}

/* ---- CRUD ---- */

function findByUsername(username) {
  return readAll().find(u => u.username === username) || null;
}

function findById(id) {
  return readAll().find(u => u.id === id) || null;
}

function findByToken(token) {
  if (!token) return null;
  const users = readAll();
  for (const u of users) {
    if (u.sessions && u.sessions.some(s => s.token === token && s.expires > Date.now())) {
      return u;
    }
  }
  return null;
}

function createUser(username, password) {
  username = String(username || '').trim().toLowerCase();
  if (!username || username.length < 3) {
    throw new Error('Username must be at least 3 characters.');
  }
  if (!/^[a-z0-9_]+$/.test(username)) {
    throw new Error('Username can only contain letters, numbers, and underscores.');
  }
  if (!password || password.length < 4) {
    throw new Error('Password must be at least 4 characters.');
  }
  if (findByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  const users = readAll();
  const salt = makeSalt();
  const now = Date.now();
  const user = {
    id: 'usr_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    username,
    passwordHash: hashPassword(password, salt),
    salt,
    coins: STARTER_COINS,
    isUnlimited: false,
    isAdmin: false,
    createdAt: now,
    sessions: [],
  };
  users.push(user);
  writeAll(users);
  return user;
}

function verifyPassword(user, password) {
  return user.passwordHash === hashPassword(password, user.salt);
}

function createSession(user, ttlMs = 30 * MS_PER_DAY) {
  const users = readAll();
  const idx = users.findIndex(u => u.id === user.id);
  if (idx === -1) return null;
  const token = makeToken();
  const session = { token, expires: Date.now() + ttlMs, createdAt: Date.now() };
  users[idx].sessions = (users[idx].sessions || []).concat(session);
  // cap stored sessions
  if (users[idx].sessions.length > 10) users[idx].sessions = users[idx].sessions.slice(-10);
  writeAll(users);
  return token;
}

function destroySession(token) {
  if (!token) return;
  const users = readAll();
  for (const u of users) {
    if (u.sessions) u.sessions = u.sessions.filter(s => s.token !== token);
  }
  writeAll(users);
}

function updateCoins(userId, delta) {
  const users = readAll();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  if (users[idx].isUnlimited) return users[idx]; // admin: no change
  users[idx].coins = Math.max(0, users[idx].coins + delta);
  users[idx].updatedAt = Date.now();
  writeAll(users);
  return users[idx];
}

function setCoins(userId, amount) {
  const users = readAll();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  users[idx].coins = Math.max(0, Math.floor(amount));
  users[idx].updatedAt = Date.now();
  writeAll(users);
  return users[idx];
}

function updateUser(userId, patch) {
  const users = readAll();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...patch, updatedAt: Date.now() };
  writeAll(users);
  return users[idx];
}

function listAllUsers() {
  return readAll().map(u => ({
    id: u.id,
    username: u.username,
    coins: u.coins,
    isUnlimited: u.isUnlimited,
    isAdmin: u.isAdmin,
    createdAt: u.createdAt,
  }));
}

function getBalance(userId) {
  const u = findById(userId);
  if (!u) return null;
  return { coins: u.coins, isUnlimited: u.isUnlimited, isAdmin: u.isAdmin };
}

module.exports = {
  seedAdmin,
  findByUsername,
  findById,
  findByToken,
  createUser,
  verifyPassword,
  createSession,
  destroySession,
  updateCoins,
  setCoins,
  updateUser,
  listAllUsers,
  getBalance,
  getAdminToken,
  // economy constants
  STARTER_COINS,
  COINS_PER_BOT_PER_DAY,
  COIN_TICK_MS,
  MS_PER_DAY,
  // admin creds (for seeding reference)
  ADMIN_USERNAME,
};
