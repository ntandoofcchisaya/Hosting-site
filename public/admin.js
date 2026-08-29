/* =====================================================================
   KnightBot-Mini Hosting — Admin Panel
   - User list, coin grants, unlimited toggle
   - Bot engine install from GitHub repo
   - All bots overview (across all users)
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

  /* If a response is 401, the session has expired (e.g. server restarted on
     Render's ephemeral filesystem). Redirect to login so the user can get a
     fresh token. */
  function handleAuthFail(resp) {
    if (resp.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.href = '/auth?expired=1';
      return true;
    }
    return false;
  }

  function toast(msg, type = 'ok') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (type === 'error' ? 'toast-error' : 'toast-ok');
    setTimeout(() => { el.className = 'toast'; }, 3500);
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function statusBadge(status) {
    const colors = {
      online: 'status-online', starting: 'status-starting', reconnecting: 'status-reconnecting',
      stopped: 'status-stopped', error: 'status-error', logged_out: 'status-error', stopping: 'status-stopping',
    };
    const cls = colors[status] || 'status-stopped';
    return `<span class="status-pill ${cls}">${status}</span>`;
  }

  /* ---------- Auth guard ---------- */
  async function checkAuth() {
    const token = getToken();
    if (!token) { window.location.href = '/auth'; return null; }
    const user = getUser();
    if (!user || !user.isAdmin) {
      // Verify with server
      try {
        const resp = await fetch('/api/auth/me', { headers: { 'x-auth-token': token } });
        const data = await resp.json();
        if (!resp.ok || !data.user || !data.user.isAdmin) {
          window.location.href = '/dashboard';
          return null;
        }
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        return data.user;
      } catch (_) {
        window.location.href = '/auth';
        return null;
      }
    }
    return user;
  }

  /* ---------- Load users ---------- */
  async function loadUsers() {
    try {
      const resp = await fetch('/api/admin/users', { headers: authHeaders() });
      if (handleAuthFail(resp)) return;
      const data = await resp.json();
      if (!resp.ok) { toast(data.error || 'Failed to load users', 'error'); return; }

      const body = $('usersBody');
      if (!data.users || data.users.length === 0) {
        body.innerHTML = '<tr><td colspan="6" class="loading-cell">No users found.</td></tr>';
        return;
      }

      body.innerHTML = data.users.map(u => `
        <tr data-user-id="${u.id}">
          <td class="user-cell">
            <strong>${u.username}</strong>
            ${u.isAdmin ? '<span class="tag tag-admin">ADMIN</span>' : ''}
          </td>
          <td class="coins-cell">
            <span class="coin-amount">${u.isUnlimited ? '∞' : u.coins}</span>
          </td>
          <td>
            <label class="switch">
              <input type="checkbox" class="unlimited-toggle" data-user-id="${u.id}" ${u.isUnlimited ? 'checked' : ''} ${u.isAdmin ? 'disabled' : ''} />
              <span class="slider"></span>
            </label>
          </td>
          <td>${u.isAdmin ? '✅' : '—'}</td>
          <td class="muted">${fmtDate(u.createdAt)}</td>
          <td class="actions-cell">
            <button class="btn-tiny grant-btn" data-user-id="${u.id}" data-amount="100" ${u.isAdmin ? 'disabled' : ''}>+100</button>
            <button class="btn-tiny grant-btn" data-user-id="${u.id}" data-amount="500" ${u.isAdmin ? 'disabled' : ''}>+500</button>
            <button class="btn-tiny set-btn" data-user-id="${u.id}" ${u.isAdmin ? 'disabled' : ''}>Set…</button>
          </td>
        </tr>
      `).join('');

      // Bind unlimited toggles
      document.querySelectorAll('.unlimited-toggle').forEach(el => {
        el.addEventListener('change', async (e) => {
          const userId = e.target.dataset.userId;
          const unlimited = e.target.checked;
          try {
            const r = await fetch(`/api/admin/users/${userId}/unlimited`, {
              method: 'POST', headers: authHeaders(),
              body: JSON.stringify({ unlimited }),
            });
            const d = await r.json();
            if (r.ok) { toast(`Unlimited ${unlimited ? 'enabled' : 'disabled'}`); loadUsers(); }
            else toast(d.error || 'Failed', 'error');
          } catch (_) { toast('Network error', 'error'); }
        });
      });

      // Bind grant buttons
      document.querySelectorAll('.grant-btn').forEach(el => {
        el.addEventListener('click', async (e) => {
          const userId = e.target.dataset.userId;
          const amount = parseInt(e.target.dataset.amount, 10);
          try {
            const r = await fetch(`/api/admin/users/${userId}/coins`, {
              method: 'POST', headers: authHeaders(),
              body: JSON.stringify({ amount, action: 'add' }),
            });
            const d = await r.json();
            if (r.ok) { toast(`Granted ${amount} coins to ${d.user.username}`); loadUsers(); }
            else toast(d.error || 'Failed', 'error');
          } catch (_) { toast('Network error', 'error'); }
        });
      });

      // Bind set buttons
      document.querySelectorAll('.set-btn').forEach(el => {
        el.addEventListener('click', async (e) => {
          const userId = e.target.dataset.userId;
          const amount = prompt('Set coins to what value?');
          if (amount === null) return;
          const amt = parseInt(amount, 10);
          if (isNaN(amt)) { toast('Invalid number', 'error'); return; }
          try {
            const r = await fetch(`/api/admin/users/${userId}/coins`, {
              method: 'POST', headers: authHeaders(),
              body: JSON.stringify({ amount: amt, action: 'set' }),
            });
            const d = await r.json();
            if (r.ok) { toast(`Coins set to ${amt}`); loadUsers(); }
            else toast(d.error || 'Failed', 'error');
          } catch (_) { toast('Network error', 'error'); }
        });
      });

      // Update stats
      $('statUsers').textContent = data.users.length;
    } catch (err) {
      toast('Failed to load users', 'error');
    }
  }

  /* ---------- Load engine status ---------- */
  async function loadEngineStatus() {
    try {
      const resp = await fetch('/api/admin/repo-status', { headers: authHeaders() });
      if (handleAuthFail(resp)) return;
      const data = await resp.json();
      if (!resp.ok) { $('engineStatusText').textContent = 'Error'; return; }

      if (data.installed) {
        $('engineStatusText').innerHTML = '<span class="status-pill status-online">Installed</span>';
        $('engineDetails').style.display = 'flex';
        $('enginePkg').textContent = (data.name || 'unknown') + (data.version ? ' v' + data.version : '');
        $('enginePathRow').style.display = 'flex';
        $('enginePath').textContent = data.path || '—';
        $('statEngine').textContent = 'Active';
      } else {
        $('engineStatusText').innerHTML = '<span class="status-pill status-stopped">Not Installed</span>';
        $('engineDetails').style.display = 'none';
        $('enginePathRow').style.display = 'none';
        $('statEngine').textContent = 'None';
      }
    } catch (_) {
      $('engineStatusText').textContent = 'Error checking status';
    }
  }

  /* ---------- Install repo ---------- */
  async function installRepo(repoUrl) {
    $('installRepoBtn').disabled = true;
    $('installRepoBtn').textContent = 'Installing… (this may take a while)';
    $('engineMsg').style.display = 'none';

    try {
      const resp = await fetch('/api/admin/install-repo', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ repoUrl }),
      });
      if (handleAuthFail(resp)) return;
      const data = await resp.json();
      const msgEl = $('engineMsg');

      if (resp.ok && data.ok) {
        msgEl.className = 'engine-msg engine-msg-ok';
        msgEl.textContent = '✅ ' + data.message;
        msgEl.style.display = 'block';
        toast('Bot engine installed successfully!');
        loadEngineStatus();
      } else {
        msgEl.className = 'engine-msg engine-msg-error';
        msgEl.textContent = '❌ ' + (data.error || 'Installation failed');
        msgEl.style.display = 'block';
        toast(data.error || 'Installation failed', 'error');
      }
    } catch (err) {
      toast('Network error during install', 'error');
    }

    $('installRepoBtn').disabled = false;
    $('installRepoBtn').textContent = 'Install Engine';
  }

  /* ---------- Remove repo ---------- */
  async function removeRepo() {
    if (!confirm('Remove the installed bot engine? All bots will fall back to the lite handler.')) return;
    try {
      const resp = await fetch('/api/admin/repo', { method: 'DELETE', headers: authHeaders() });
      if (handleAuthFail(resp)) return;
      const data = await resp.json();
      if (resp.ok) { toast('Engine removed'); loadEngineStatus(); }
      else toast(data.error || 'Failed', 'error');
    } catch (_) { toast('Network error', 'error'); }
  }

  /* ---------- Load all bots ---------- */
  async function loadAllBots() {
    try {
      const resp = await fetch('/api/admin/bots', { headers: authHeaders() });
      if (handleAuthFail(resp)) return;
      const data = await resp.json();
      if (!resp.ok) { toast(data.error || 'Failed to load bots', 'error'); return; }

      const body = $('botsBody');
      const bots = data.bots || [];

      if (bots.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="loading-cell">No bots deployed yet.</td></tr>';
        $('statBots').textContent = '0';
        $('statRunning').textContent = '0';
        return;
      }

      body.innerHTML = bots.map(b => `
        <tr>
          <td><strong>${b.name}</strong><br><code class="bot-id">${b.id}</code></td>
          <td>${b.ownerUsername}</td>
          <td>${statusBadge(b.status)}</td>
          <td class="muted">${fmtDate(b.createdAt)}</td>
          <td>
            <button class="btn-tiny danger delete-bot-btn" data-bot-id="${b.id}">Delete</button>
          </td>
        </tr>
      `).join('');

      // Bind delete
      document.querySelectorAll('.delete-bot-btn').forEach(el => {
        el.addEventListener('click', async (e) => {
          const botId = e.target.dataset.botId;
          if (!confirm('Delete this bot permanently?')) return;
          try {
            const r = await fetch(`/api/admin/bots/${botId}`, { method: 'DELETE', headers: authHeaders() });
            if (r.ok) { toast('Bot deleted'); loadAllBots(); }
            else { const d = await r.json(); toast(d.error || 'Failed', 'error'); }
          } catch (_) { toast('Network error', 'error'); }
        });
      });

      $('statBots').textContent = bots.length;
      $('statRunning').textContent = bots.filter(b => ['online', 'starting', 'reconnecting'].includes(b.status)).length;
    } catch (_) {
      toast('Failed to load bots', 'error');
    }
  }

  /* ---------- Tab switching ---------- */
  function bindTabs() {
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        $('sectionUsers').style.display = target === 'users' ? 'block' : 'none';
        $('sectionEngine').style.display = target === 'engine' ? 'block' : 'none';
        $('sectionBots').style.display = target === 'bots' ? 'block' : 'none';
        if (target === 'bots') loadAllBots();
        if (target === 'engine') loadEngineStatus();
      });
    });
  }

  /* ---------- Init ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    const user = await checkAuth();
    if (!user) return;

    $('navUserBadge').textContent = '👤 ' + user.username;

    $('logoutBtn').addEventListener('click', (e) => {
      e.preventDefault();
      fetch('/api/auth/logout', { method: 'POST', headers: authHeaders(), body: '{}' });
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      window.location.href = '/auth';
    });

    bindTabs();

    // Refresh buttons
    $('refreshUsers').addEventListener('click', loadUsers);
    $('refreshBots').addEventListener('click', loadAllBots);
    $('refreshEngineBtn').addEventListener('click', loadEngineStatus);
    $('removeRepoBtn').addEventListener('click', removeRepo);

    // Install repo
    $('installRepoBtn').addEventListener('click', () => {
      const url = $('repoUrl').value.trim();
      if (!url) { toast('Please enter a GitHub repo URL', 'error'); return; }
      if (!/^https:\/\/github\.com\//.test(url)) { toast('URL must start with https://github.com/', 'error'); return; }
      installRepo(url);
    });

    // Preset repos
    document.querySelectorAll('[data-repo]').forEach(el => {
      el.addEventListener('click', () => { $('repoUrl').value = el.dataset.repo; });
    });

    // Initial loads
    loadUsers();
    loadEngineStatus();
    loadAllBots();
  });
})();
