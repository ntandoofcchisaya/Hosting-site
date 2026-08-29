/* =====================================================================
   KnightBot-Mini Multi-Hosting Dashboard
   - Auth-token identity (stored in localStorage after login)
   - Bot CRUD + lifecycle (start/stop/restart/delete)
   - Live status polling + live logs viewer
   - 3-step "Create New Bot" wizard
   - Coin balance display + runtime estimate
   ===================================================================== */

(function () {
  'use strict';

  const TOKEN_KEY = 'kb_auth_token';
  const USER_KEY = 'kb_user';
  const $ = (id) => document.getElementById(id);

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (_) { return null; } }
  function authHeaders() {
    return { 'Content-Type': 'application/json', 'x-auth-token': getToken() || '' };
  }

  /* ---------- Auth guard ---------- */
  async function checkAuth() {
    const token = getToken();
    if (!token) { window.location.href = '/auth'; return null; }
    try {
      const resp = await fetch('/api/auth/me', { headers: { 'x-auth-token': token } });
      const data = await resp.json();
      if (!resp.ok || !data.user) { window.location.href = '/auth'; return null; }
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
      return data;
    } catch (_) {
      window.location.href = '/auth';
      return null;
    }
  }

  /* ---------- Init ---------- */
  let currentUser = null;
  let economyEstimate = null;

  document.addEventListener('DOMContentLoaded', async () => {
    const authData = await checkAuth();
    if (!authData) return;
    currentUser = authData.user;
    economyEstimate = authData.economy;

    // Nav: show username
    const badge = $('navUserBadge');
    if (badge) badge.textContent = '👤 ' + currentUser.username;

    // Nav: admin link (only for admins)
    if (currentUser.isAdmin) {
      const adminLink = $('adminNavLink');
      if (adminLink) adminLink.style.display = 'inline-block';
    }

    // Logout
    $('logoutBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      fetch('/api/auth/logout', { method: 'POST', headers: authHeaders(), body: '{}' });
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.href = '/auth';
    });

    // Coin display
    updateCoinDisplay();

    // Create bot button
    $('createBotBtn')?.addEventListener('click', openCreateModal);

    // Modal close handlers
    document.querySelectorAll('[data-close]').forEach(el => {
      el.addEventListener('click', () => closeModal(el.dataset.close));
    });
    $('createModal')?.addEventListener('click', e => { if (e.target.id === 'createModal') closeModal('createModal'); });
    $('logsPanel')?.addEventListener('click', e => { if (e.target.id === 'logsPanel') closeModal('logsPanel'); });

    // Wizard navigation
    $('toStep2Btn')?.addEventListener('click', () => goToStep(2));
    $('backToStep1Btn')?.addEventListener('click', () => goToStep(1));
    $('toStep3Btn')?.addEventListener('click', () => { buildReview(); goToStep(3); });
    $('backToStep2Btn')?.addEventListener('click', () => goToStep(2));
    $('launchBotBtn')?.addEventListener('click', launchBot);

    // Logs
    $('refreshLogsBtn')?.addEventListener('click', () => currentLogBot && fetchLogs(currentLogBot));

    // Initial load
    fetchBots();
    setInterval(fetchBots, 5000);
    // Refresh coin balance every 30s
    setInterval(fetchBalance, 30000);
  });

  /* ---------- Coin display ---------- */
  function updateCoinDisplay() {
    if (!currentUser) return;
    const coinEl = $('coinBalance');
    const estEl = $('coinEstimate');
    const coinSection = $('coinSection');
    if (coinSection) coinSection.style.display = 'flex';

    if (currentUser.isUnlimited) {
      if (coinEl) coinEl.textContent = '∞';
      if (estEl) estEl.textContent = 'Unlimited runtime (Admin)';
    } else {
      if (coinEl) coinEl.textContent = currentUser.coins;
      if (estEl && economyEstimate) {
        const est = economyEstimate.estimate || economyEstimate;
        if (est.botDays === 'unlimited' || est.unlimited) {
          estEl.textContent = 'Unlimited runtime';
        } else {
          const days = typeof est.botDays === 'number' ? est.botDays.toFixed(1) : est.botDays;
          const runningTxt = est.runningBots ? ` (${est.runningBots} running)` : '';
          estEl.textContent = `≈ ${days} bot-days${runningTxt}`;
        }
      }
    }
  }

  async function fetchBalance() {
    try {
      const resp = await fetch('/api/coins/balance', { headers: authHeaders() });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        currentUser.coins = data.coins;
        currentUser.isUnlimited = data.isUnlimited;
        economyEstimate = { estimate: data.estimate };
        updateCoinDisplay();
      }
    } catch (_) {}
  }

  /* ---------- API helpers ---------- */
  async function api(method, url, body) {
    const opts = {
      method,
      headers: authHeaders(),
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* ---------- Bots list ---------- */
  let botsCache = [];

  async function fetchBots() {
    try {
      const data = await api('GET', '/api/bots');
      botsCache = data.bots || [];
      if (data.economy) {
        economyEstimate = { estimate: data.economy };
        if (currentUser && !currentUser.isUnlimited) {
          updateCoinDisplay();
        }
      }
      renderBots();
      renderStats();
    } catch (err) {
      if (err.message.includes('Authentication')) {
        window.location.href = '/auth';
        return;
      }
      $('dashLoader').innerHTML = `<div style="color:var(--red);">⚠️ ${err.message}</div>`;
    }
  }

  function renderStats() {
    const total = botsCache.length;
    const online = botsCache.filter(b => b.status === 'online').length;
    const stopped = botsCache.filter(b => b.status === 'stopped').length;
    const issues = botsCache.filter(b => ['error', 'logged_out', 'reconnecting'].includes(b.status)).length;
    $('statTotal').textContent = total;
    $('statOnline').textContent = online;
    $('statStopped').textContent = stopped;
    $('statError').textContent = issues;
  }

  function renderBots() {
    $('dashLoader').style.display = 'none';
    const grid = $('botGrid');
    const empty = $('emptyState');

    if (!botsCache.length) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    grid.style.display = 'grid';

    grid.innerHTML = botsCache.map(bot => botCardHTML(bot)).join('');

    grid.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleBotAction(btn.dataset.action, btn.dataset.id, btn.dataset.name));
    });
  }

  function botCardHTML(bot) {
    const status = bot.status || 'stopped';
    const detail = bot.detail || {};
    const phone = detail.phoneNumber ? formatPhone(detail.phoneNumber) : '—';
    const botName = detail.botName || bot.name;
    const created = new Date(bot.createdAt).toLocaleDateString();
    const isRunning = ['online', 'starting', 'reconnecting', 'stopping'].includes(status);

    return `
    <div class="bot-card">
      <div class="bot-card-head">
        <div>
          <div class="bot-name">⚔️ ${escapeHtml(bot.name)}</div>
          <div class="bot-id">${bot.id}</div>
        </div>
        <span class="status-badge ${status}"><span class="pulse"></span>${status.replace('_', ' ')}</span>
      </div>
      <div class="bot-meta">
        ${status === 'online' ? `<div>📱 <b>${escapeHtml(phone)}</b></div>` : ''}
        <div>🏷️ Bot name: <b>${escapeHtml(botName)}</b></div>
        <div>🗓️ Created: <b>${created}</b></div>
        ${status === 'online' && detail.botName ? `<div>✅ Connected as <b>${escapeHtml(detail.botName)}</b></div>` : ''}
        ${status === 'error' && detail.error ? `<div style="color:var(--red);">⚠️ ${escapeHtml(detail.error)}</div>` : ''}
      </div>
      <div class="bot-actions">
        ${isRunning
          ? `<button class="btn-sm stop" data-action="stop" data-id="${bot.id}" data-name="${escapeAttr(bot.name)}">⏹ Stop</button>
             <button class="btn-sm restart" data-action="restart" data-id="${bot.id}" data-name="${escapeAttr(bot.name)}">♻️ Restart</button>`
          : `<button class="btn-sm start" data-action="start" data-id="${bot.id}" data-name="${escapeAttr(bot.name)}">▶ Start</button>`
        }
        <button class="btn-sm" data-action="logs" data-id="${bot.id}" data-name="${escapeAttr(bot.name)}">📋 Logs</button>
        <button class="btn-sm delete" data-action="delete" data-id="${bot.id}" data-name="${escapeAttr(bot.name)}">🗑 Delete</button>
      </div>
    </div>`;
  }

  function formatPhone(n) {
    const s = String(n);
    if (s.length <= 4) return s;
    return '+' + s.slice(0, -7) + ' ' + s.slice(-7, -4) + ' ' + s.slice(-4);
  }

  /* ---------- Bot actions ---------- */
  async function handleBotAction(action, id, name) {
    try {
      switch (action) {
        case 'start':
          toast(`Starting "${name}"…`, 'ok');
          await api('POST', `/api/bots/${id}/start`);
          toast(`"${name}" is starting`, 'ok');
          setTimeout(fetchBots, 800);
          break;
        case 'stop':
          toast(`Stopping "${name}"…`, 'ok');
          await api('POST', `/api/bots/${id}/stop`);
          setTimeout(fetchBots, 800);
          break;
        case 'restart':
          toast(`Restarting "${name}"…`, 'ok');
          await api('POST', `/api/bots/${id}/restart`);
          setTimeout(fetchBots, 800);
          break;
        case 'logs':
          openLogs(id, name);
          break;
        case 'delete':
          if (confirm(`Delete "${name}"? This stops the bot and removes it permanently.`)) {
            await api('DELETE', `/api/bots/${id}`);
            toast(`"${name}" deleted`, 'ok');
            fetchBots();
          }
          break;
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* ---------- Create Bot Wizard ---------- */
  function openCreateModal() {
    resetWizard();
    $('createModal').classList.add('open');
  }

  function resetWizard() {
    goToStep(1);
    $('newBotName').value = '';
    $('newBotSession').value = '';
    $('newBotPrefix').value = ',';
    $('newBotOwner').value = '';
    $('newBotOwnerName').value = 'Admin';
    $('newBotSelfMode').checked = false;
    $('newBotAutoReact').checked = false;
    $('newBotStatusSave').checked = false;
    $('newBotReadMsg').checked = false;
    $('newBotAutoStart').checked = true;
  }

  function goToStep(n) {
    for (let i = 1; i <= 3; i++) {
      $('modalStep' + i).style.display = 'none';
      const step = $('mStep' + i);
      step.classList.remove('active', 'done');
      if (i < n) step.classList.add('done');
      else if (i === n) step.classList.add('active');
    }
    $('modalStep' + n).style.display = 'block';
  }

  function buildReview() {
    const cfg = collectConfig();
    const lines = [
      `<b style="color:var(--accent-2);">Name:</b> ${escapeHtml(cfg.name)}`,
      `<b style="color:var(--accent-2);">Session:</b> KnightBot!${'•'.repeat(20)}… (${cfg.sessionId.length} chars)`,
      `<b style="color:var(--accent-2);">Prefix:</b> "${escapeHtml(cfg.config.prefix)}"`,
      `<b style="color:var(--accent-2);">Owner:</b> ${escapeHtml(cfg.config.ownerNumber || '—')} (${escapeHtml((cfg.config.ownerName||[]).join(', '))})`,
      `<b style="color:var(--accent-2);">Bot Name:</b> ${escapeHtml(cfg.config.botName)}`,
      `<b style="color:var(--accent-2);">Self Mode:</b> ${cfg.config.selfMode ? 'ON' : 'OFF'}`,
      `<b style="color:var(--accent-2);">Auto React:</b> ${cfg.config.autoReact ? 'ON' : 'OFF'}`,
      `<b style="color:var(--accent-2);">Auto Status Save:</b> ${cfg.config.autoStatusSave ? 'ON' : 'OFF'}`,
      `<b style="color:var(--accent-2);">Read Messages:</b> ${cfg.config.readMessage ? 'ON' : 'OFF'}`,
      `<b style="color:var(--accent-2);">Auto-start on boot:</b> ${cfg.autoStart ? 'YES' : 'NO'}`,
    ];
    $('reviewBox').innerHTML = lines.join('<br/>');
  }

  function collectConfig() {
    const name = ($('newBotName').value || '').trim();
    const sessionId = ($('newBotSession').value || '').trim();
    return {
      name,
      sessionId,
      autoStart: $('newBotAutoStart').checked,
      config: {
        prefix: ($('newBotPrefix').value || ',').trim(),
        ownerNumber: ($('newBotOwner').value || '').replace(/[^0-9]/g, ''),
        ownerName: ($('newBotOwnerName').value || 'Admin').split(',').map(s => s.trim()).filter(Boolean),
        botName: name || 'KnightBot',
        selfMode: $('newBotSelfMode').checked,
        autoReact: $('newBotAutoReact').checked,
        autoStatusSave: $('newBotStatusSave').checked,
        readMessage: $('newBotReadMsg').checked,
      },
    };
  }

  async function launchBot() {
    const cfg = collectConfig();
    if (!cfg.name || cfg.name.length < 2) { toast('Enter a bot name (min 2 chars)', 'err'); goToStep(1); return; }
    if (!cfg.sessionId || !cfg.sessionId.startsWith('KnightBot!')) { toast('Invalid session string', 'err'); goToStep(1); return; }

    const btn = $('launchBotBtn');
    btn.disabled = true;
    btn.textContent = 'Launching…';
    try {
      const res = await api('POST', '/api/bots/create', cfg);
      toast(`Bot "${cfg.name}" created & launching!`, 'ok');
      closeModal('createModal');
      fetchBots();
      fetchBalance();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 Launch Bot';
    }
  }

  /* ---------- Logs ---------- */
  let currentLogBot = null;
  let logPollTimer = null;

  function openLogs(id, name) {
    currentLogBot = id;
    $('logsTitle').textContent = `📋 ${name} — Live Logs`;
    $('logsPanel').classList.add('open');
    fetchLogs(id);
    clearInterval(logPollTimer);
    logPollTimer = setInterval(() => { if (currentLogBot) fetchLogs(currentLogBot, true); }, 4000);
  }

  async function fetchLogs(id, silent) {
    try {
      const data = await api('GET', `/api/bots/${id}/logs?limit=150`);
      const body = $('logsBody');
      if (!data.logs || !data.logs.length) {
        if (!silent) body.innerHTML = '<div class="log-line">No logs yet. Start the bot to see output.</div>';
        return;
      }
      body.innerHTML = data.logs.map(l => classifyLog(l)).join('\n');
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      if (!silent) $('logsBody').innerHTML = `<div class="log-line err">⚠️ ${escapeHtml(err.message)}</div>`;
    }
  }

  function classifyLog(line) {
    const cls = /❌|error|Error|ERR/i.test(line) ? 'err'
              : /✅|online|connected|Status: online/i.test(line) ? 'ok'
              : /♻️|warn|Warn/i.test(line) ? 'warn' : '';
    return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
  }

  /* ---------- Modal helpers ---------- */
  function closeModal(id) {
    $(id)?.classList.remove('open');
    if (id === 'logsPanel') {
      currentLogBot = null;
      clearInterval(logPollTimer);
    }
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg, type) {
    const t = $('dashToast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------- Utils ---------- */
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

})();
