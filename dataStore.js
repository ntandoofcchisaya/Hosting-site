/**
 * Persistent JSON data store for the multi-hosting platform.
 * Stores bot instance configs + metadata in /data/bots.json
 * Keeps things dependency-free and Render-ephemeral-disk friendly.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDir();
  try {
    if (!fs.existsSync(BOTS_FILE)) return [];
    const raw = fs.readFileSync(BOTS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

function writeAll(bots) {
  ensureDir();
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2), 'utf8');
}

/**
 * Get all bots (optionally for a given owner token).
 */
function listBots(ownerToken) {
  const bots = readAll();
  if (!ownerToken) return bots;
  return bots.filter((b) => b.ownerToken === ownerToken);
}

/**
 * Get a single bot by id.
 */
function getBot(id) {
  return readAll().find((b) => b.id === id) || null;
}

/**
 * Create a new bot record.
 * Auto-generates id + timestamps.
 */
function createBot(bot) {
  const bots = readAll();
  const now = Date.now();
  const record = {
    id: 'bot_' + now.toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: now,
    updatedAt: now,
    autoStart: true,
    ...bot,
  };
  bots.push(record);
  writeAll(bots);
  return record;
}

/**
 * Update an existing bot (merge).
 */
function updateBot(id, patch) {
  const bots = readAll();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  bots[idx] = { ...bots[idx], ...patch, updatedAt: Date.now() };
  writeAll(bots);
  return bots[idx];
}

/**
 * Delete a bot record.
 */
function deleteBot(id) {
  const bots = readAll();
  const next = bots.filter((b) => b.id !== id);
  writeAll(next);
  return bots.length !== next.length;
}

module.exports = {
  listBots,
  getBot,
  createBot,
  updateBot,
  deleteBot,
};
