# ⚔️ KnightBot-Mini Multi-Hosting Platform

A full **multi-tenant hosting platform** for the [KnightBot-Mini](https://github.com/mruniquehacker/KnightBot-Mini) WhatsApp bot. Users generate pair codes, obtain session strings, and **launch & manage multiple bot instances** from a single web dashboard — each bot runs in its own isolated process with live status and logs.

Built to deploy on **Render** out of the box.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Pair-Code Generator** | Enter your WhatsApp number → get a pairing code → link device → receive a `KnightBot!...` session string. No QR terminal needed. |
| **Multi-Hosting Dashboard** | Create unlimited bot instances, each with its own session & config. Start, stop, restart, and delete from one UI. |
| **User Accounts** | Free account creation with username/password. Secure SHA-256 + per-user salt password hashing. Session tokens with 30-day TTL. |
| **Coin System** | 10 coins = 1 bot running for 1 day. New users get 50 free starter coins (5 bot-days). Coins are deducted proportionally every 10 minutes of runtime. Bots auto-stop when coins run out. |
| **Admin Panel** | Admin can grant/set coins to users, toggle unlimited coins, view all users and all bots across the platform, delete any bot, and install the bot engine from a GitHub repo. |
| **Bot Engine Installation** | Admin can clone any GitHub bot engine repo directly from the admin panel UI. The engine is installed into `./knightbot-engine` and used by all bot workers. |
| **Isolated Bot Processes** | Every bot runs as a separate `child_process.fork()` worker — one bot crashing never affects another. |
| **Live Logs** | Real-time per-bot log viewer in the dashboard (circular buffer, last 200 lines). |
| **Auto-Restart on Crash** | Workers that exit unexpectedly auto-restart (up to 5 restarts per 60s window). |
| **Boot-Time Restoration** | Bots marked `autoStart` are automatically re-spawned when the platform restarts. |
| **Config Builder** | Visually build your `config.js` / env vars with a live YAML preview. |
| **Render Deploy Guide** | Step-by-step blueprint + `render.yaml` for one-click Render deployment. |
| **Lightweight Fallback** | If the full KnightBot-Mini engine isn't cloned, a built-in `liteHandler.js` provides working commands (menu, ping, alive, sticker, info). |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Render Web Service                 │
│                   (server.js / Express)              │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Landing Page │  │  Dashboard   │  │  Pair Code │  │
│  │  index.html  │  │dashboard.html│  │  Generator │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
│         │                 │                │         │
│         ▼                 ▼                ▼         │
│  ┌──────────────────────────────────────────────┐   │
│  │            Bot Management API                 │   │
│  │  /api/bots/create  /api/bots  /api/bots/:id   │   │
│  │  /start  /stop  /restart  /status  /logs      │   │
│  └──────────────────────────────────────────────┘   │
│         │                                           │
│         ▼                                           │
│  ┌──────────────────────────────────────────────┐   │
│  │            botManager.js                      │   │
│  │  Process registry + lifecycle + auto-restart  │   │
│  └──────────────────────────────────────────────┘   │
│         │ fork()           │ fork()         │ fork()│
│         ▼                  ▼                ▼       │
│  ┌──────────┐       ┌──────────┐      ┌──────────┐  │
│  │bot-worker│       │bot-worker│      │bot-worker│  │
│  │  Bot #1  │       │  Bot #2  │      │  Bot #3  │  │
│  │ (Baileys)│       │ (Baileys)│      │ (Baileys)│  │
│  └──────────┘       └──────────┘      └──────────┘  │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │  dataStore.js  →  /data/bots.json (JSON DB)   │   │
│  │  /data/bots/<id>/config.json + session/       │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|---|---|
| `server.js` | Express server: static files, pair-code API, bot management API |
| `botManager.js` | Bot lifecycle: spawn/stop/restart, process registry, auto-restart, log buffering |
| `bot-worker.js` | Child process that runs ONE bot: decodes session, loads engine or liteHandler, Baileys socket |
| `liteHandler.js` | Lightweight fallback command handler (menu/ping/alive/sticker/info) |
| `dataStore.js` | JSON file DB for bot records (`/data/bots.json`) |
| `public/index.html` | Landing page (features, pair code, config builder, deploy guide) |
| `public/dashboard.html` | Multi-hosting dashboard (bot grid, create wizard, logs panel) |
| `public/dashboard.js` | Dashboard frontend logic (CRUD, lifecycle, live polling, wizard) |
| `public/app.js` | Landing page logic (pair code generator, config builder) |
| `public/styles.css` | Dark knight theme (shared across landing + dashboard) |

---

## 🚀 Quick Start (Local)

```bash
git clone https://github.com/mruniquehacker/KnightBot-Mini-Hosting.git
cd KnightBot-Mini-Hosting
npm install
npm start
```

Open `http://localhost:3000` → click **Sign In** → **Register** for a free account (or login as admin with `ntando` / `ntandoooe`) → go to **Dashboard** → **Create New Bot**.

---

## ☁️ Deploy on Render

1. **Fork/push** this repo to GitHub.
2. On [Render](https://dashboard.render.com), click **New → Web Service**.
3. Connect your repo. Render auto-detects Node.js.
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. (Optional) Add `render.yaml` blueprint for one-click deploys.
6. Deploy. Your platform is live — share the URL with users.

> **Note:** Render's free tier has ephemeral disk storage. Bot session data in `/data` resets on redeploy. For persistent multi-bot hosting, attach a Render Disk to `/data` or use a managed DB.

---

## 📡 API Reference

### Authentication & Accounts

All bot management and admin routes require an `x-auth-token` header (obtained on login/register, stored in `localStorage` as `kb_auth_token`).

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | — | Create a free account `{ username, password }` → returns token + user (50 starter coins) |
| `POST` | `/api/auth/login` | — | Login `{ username, password }` → returns token + user |
| `POST` | `/api/auth/logout` | token | Invalidate the current session token |
| `GET` | `/api/auth/me` | token | Get current user profile + coin balance + runtime estimate |
| `GET` | `/api/coins/balance` | user | Get coin balance + runtime estimate |

### Bot Management (user-scoped)

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/bots/create` | user | Create a bot `{ name, sessionId, config, autoStart }` — checks coins if auto-starting |
| `GET` | `/api/bots` | user | List your bots with live status + economy estimate |
| `GET` | `/api/bots/:id` | user | Get bot record + status (owner or admin only) |
| `PATCH` | `/api/bots/:id` | user | Update bot name/config/autoStart |
| `DELETE` | `/api/bots/:id` | user | Stop + permanently delete a bot |
| `POST` | `/api/bots/:id/start` | user | Start a stopped bot (returns 402 if insufficient coins) |
| `POST` | `/api/bots/:id/stop` | user | Stop a running bot |
| `POST` | `/api/bots/:id/restart` | user | Restart a bot |
| `GET` | `/api/bots/:id/status` | user | Current status (online/starting/stopped/error…) |
| `GET` | `/api/bots/:id/logs?limit=` | user | Recent log lines (max 200) |

### Admin Routes (admin only)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/users` | List all users with coins, unlimited flag, admin flag |
| `POST` | `/api/admin/users/:id/coins` | Grant or set coins `{ amount, action: 'add'\|'set' }` |
| `POST` | `/api/admin/users/:id/unlimited` | Toggle unlimited coins `{ unlimited: bool }` |
| `GET` | `/api/admin/bots` | List ALL bots across all users with owner usernames |
| `DELETE` | `/api/admin/bots/:id` | Delete any bot (admin override) |
| `POST` | `/api/admin/install-repo` | Clone a GitHub repo as the bot engine `{ repoUrl }` |
| `GET` | `/api/admin/repo-status` | Check if an engine repo is installed |
| `DELETE` | `/api/admin/repo` | Remove the installed engine |

### Other Routes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check + uptime + active bot count |
| `POST` | `/api/pair/request` | Start a pair-code session `{ phone }` |
| `GET` | `/api/pair/status?sessionId=` | Poll for pair code / session string |
| `POST` | `/api/deploy/render` | Get customized `render.yaml` blueprint |

---

## 👤 User Accounts & Coins

### Free Account Creation
Anyone can register for free at `/auth`. New accounts receive **50 starter coins**. Usernames must be 3+ characters (letters, numbers, underscores only). Passwords must be 4+ characters.

### Coin Economy
- **10 coins** = 1 bot running for 1 day (24 hours)
- Coins are deducted proportionally every 10 minutes of bot runtime (~0.07 coins per tick)
- When a non-admin user's coin balance reaches **0**, their running bots are **automatically stopped**
- The dashboard shows your live coin balance and estimated remaining runtime (bot-days)
- Admins can grant additional coins or set a user to **unlimited** mode

### Admin Account
The platform seeds a default admin account on first boot:
- **Username:** `ntando`
- **Password:** `ntandoooe`
- Admin has **unlimited coins** (bots run for free)
- Admin can access the `/admin` panel to manage all users and bots

> ⚠️ **Change the admin password after first login** by editing `userStore.js` (ADMIN_PASSWORD constant) before deploying to production.

---

## 🛡️ Admin Panel

The admin panel (`/admin`) provides:

1. **User Management** — View all users, grant coins (+100/+500 or custom set), toggle unlimited coins per user
2. **Bot Engine Installation** — Paste any GitHub repo URL to clone it as the bot engine. The engine is installed into `./knightbot-engine` and used by all bot workers. Includes a quick-install preset for KnightBot-Mini.
3. **All Bots Overview** — View every bot instance across all users, with status and owner. Admin can delete any bot.

---

## 🔧 How It Works

1. **Get a session:** User enters their WhatsApp number in the pair-code generator. The server opens a Baileys socket, calls `requestPairingCode()`, and once the user links their device, builds a `KnightBot!<base64(gzip(creds.json))>` session string.

2. **Create a bot:** From the dashboard, the user pastes the session string + config (prefix, owner, toggles). The platform stores the bot record and forks a `bot-worker.js` process.

3. **The worker:** Decodes the session string into `creds.json`, loads the KnightBot-Mini engine (if cloned into `./knightbot-engine`) or falls back to `liteHandler.js`, creates a Baileys socket, and reports status/logs back to the manager via IPC.

4. **The manager:** Maintains a registry of all running bots, buffers logs, monitors process exits, and auto-restarts crashed workers.

5. **The dashboard:** Polls `/api/bots` every 5s for live status, and the logs panel auto-refreshes every 4s.

---

## 🧩 Using the Full KnightBot-Mini Engine

The platform works out-of-the-box with the built-in `liteHandler.js`. To enable the **full** KnightBot-Mini command set, an admin can install the engine from the admin panel:

1. Login as admin (`ntando` / `ntandoooe`)
2. Go to **Admin → Bot Engine** tab
3. Paste the repo URL: `https://github.com/mruniquehacker/KnightBot-Mini`
4. Click **Install Engine**

Or via API/CLI:

```bash
# Via API (as admin)
curl -X POST http://localhost:3000/api/admin/install-repo \
  -H "x-auth-token: <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"repoUrl":"https://github.com/mruniquehacker/KnightBot-Mini"}'

# Or manually
git clone https://github.com/mruniquehacker/KnightBot-Mini.git knightbot-engine
cd knightbot-engine && npm install --omit=dev
```

The worker auto-detects `./knightbot-engine` and loads its handler + commands. No code changes needed.

---

## 📝 License

This hosting platform is open source. KnightBot-Mini is © its respective authors. See the [original repo](https://github.com/mruniquehacker/KnightBot-Mini).
