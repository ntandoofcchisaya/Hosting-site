/* =====================================================================
   KnightBot-Mini Hosting — Frontend Logic
   - Pair code generator (polls /api/pair/*)
   - Live config.js + env preview
   - render.yaml preview
   - Copy-to-clipboard helpers
   ===================================================================== */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const toast = (msg) => {
    const t = $('toast');
    $('toastMsg').textContent = msg;
    t.classList.add('show');
    clearTimeout(window.__toastT);
    window.__toastT = setTimeout(() => t.classList.remove('show'), 2400);
  };

  /* ---------- Mobile nav ---------- */
  $('navToggle').addEventListener('click', () => $('navLinks').classList.toggle('open'));
  document.querySelectorAll('.nav-links a').forEach((a) =>
    a.addEventListener('click', () => $('navLinks').classList.remove('open'))
  );

  /* ---------- Status link ---------- */
  $('statusLink').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const r = await fetch('/health');
      const d = await r.json();
      toast(d.ok ? `Server OK · ${Math.round(d.uptime)}s uptime` : 'Server unreachable');
    } catch (_) {
      toast('Server unreachable');
    }
  });

  /* ---------- Copy helpers ---------- */
  async function copyText(text, btnId) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    toast('Copied to clipboard!');
    if (btnId) {
      const b = $(btnId);
      b.classList.add('copied'); b.textContent = '✓ Copied';
      setTimeout(() => { b.classList.remove('copied'); b.textContent = b.dataset.label || '📋 Copy'; }, 1800);
    }
  }
  window.copyText = copyText;

  function bindCopy(btnId, getText) {
    const b = $(btnId);
    if (!b) return;
    b.dataset.label = b.textContent;
    b.addEventListener('click', () => copyText(getText(), btnId));
  }

  /* =====================================================================
     PAIR CODE GENERATOR
     ===================================================================== */
  let pollTimer = null;
  let currentSessionId = null;

  const markStep = (n, done) => {
    for (let i = 1; i <= 3; i++) {
      const el = $(`step${i}`);
      el.classList.remove('active', 'done');
      if (i < n) el.classList.add('done');
      else if (i === n) el.classList.add(done ? 'done' : 'active');
    }
  };
  window.markStep = markStep;

  function resetPair() {
    clearTimeout(pollTimer);
    currentSessionId = null;
    $('pairStep1').style.display = 'block';
    $('pairCodeBox').classList.remove('show');
    $('sessionResult').classList.remove('show');
    $('pairCode').textContent = '------';
    $('phone').value = '';
    markStep(1, false);
  }
  $('newPairBtn').addEventListener('click', resetPair);

  $('requestPairBtn').addEventListener('click', async () => {
    const phone = $('phone').value.replace(/[^0-9]/g, '');
    if (phone.length < 8 || phone.length > 15) {
      toast('Enter a valid phone number with country code');
      $('phone').focus();
      return;
    }

    const btn = $('requestPairBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;"></span> Requesting…';

    try {
      const res = await fetch('/api/pair/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }

      currentSessionId = data.sessionId;
      $('pairStep1').style.display = 'none';
      $('pairCodeBox').classList.add('show');
      markStep(2, false);
      btn.disabled = false;
      btn.innerHTML = 'Request Pairing Code';

      // Start polling for the pair code + session string
      pollStatus();
    } catch (err) {
      toast(err.message || 'Failed to start pairing');
      btn.disabled = false;
      btn.innerHTML = 'Request Pairing Code';
    }
  });

  async function pollStatus() {
    if (!currentSessionId) return;
    try {
      const res = await fetch(`/api/pair/status?sessionId=${currentSessionId}`);
      const data = await res.json();

      if (data.pairCode && $('pairCode').textContent === '------') {
        $('pairCode').textContent = data.pairCode;
        $('pairSpinner').style.display = 'block';
      }

      if (data.status === 'connected' && data.sessionString) {
        // Success — show session string
        $('pairCodeBox').classList.remove('show');
        $('sessionResult').classList.add('show');
        $('sessionString').textContent = data.sessionString;
        $('pairSpinner').style.display = 'none';
        markStep(3, true);
        currentSessionId = null;
        clearTimeout(pollTimer);
        // Auto-fill the config builder session field
        if ($('cfgSession')) $('cfgSession').value = data.sessionString;
        updateConfig();
        toast('Session string ready!');
        return;
      }

      if (data.status === 'logged_out' || data.status === 'error') {
        $('pairSpinner').style.display = 'none';
        toast('Pairing failed or timed out. Please try again.');
        clearTimeout(pollTimer);
        return;
      }

      // Keep polling
      pollTimer = setTimeout(pollStatus, 3000);
    } catch (_) {
      pollTimer = setTimeout(pollStatus, 4000);
    }
  }

  bindCopy('copySessionBtn', () => $('sessionString').textContent);

  /* =====================================================================
     CONFIG BUILDER — Live preview
     ===================================================================== */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function jsStr(s) {
    return `'${String(s).replace(/'/g, "\\'")}'`;
  }

  function buildConfigJS() {
    const botName = $('cfgBotName').value.trim() || 'Knight Bot Mini';
    const prefix = $('cfgPrefix').value || ',';
    const owner = $('cfgOwner').value.replace(/[^0-9]/g, '');
    const ownerName = $('cfgOwnerName').value.trim() || 'Knight Bot';
    const session = $('cfgSession').value.trim();
    const pack = $('cfgPack').value.trim() || 'Knight Bot';
    const autoRead = $('cfgAutoRead').checked;
    const autoTyping = $('cfgAutoTyping').checked;
    const autoBio = $('cfgAutoBio').checked;
    const autoReact = $('cfgAutoReact').checked;
    const selfMode = $('cfgSelfMode').checked;

    return `module.exports = {
    // Bot Owner Configuration
    ownerNumber: ['${owner}'],
    ownerName: ['${ownerName}'],

    // Bot Configuration
    botName: ${jsStr(botName)},
    prefix: ${jsStr(prefix)},
    sessionName: 'session',
    sessionID: process.env.SESSION_ID || ${jsStr(session || '')},
    newsletterJid: '120363161513685998@newsletter',
    updateZipUrl: 'https://github.com/mruniquehacker/KnightBot-Mini/archive/refs/heads/main.zip',

    // Sticker Configuration
    packname: ${jsStr(pack)},

    // Bot Behavior
    selfMode: ${selfMode},
    autoRead: ${autoRead},
    autoTyping: ${autoTyping},
    autoBio: ${autoBio},
    autoReact: ${autoReact},
    autoReactMode: 'bot',
    autoDownload: false,

    // Timezone
    timezone: 'Asia/Kolkata',
};`;
  }

  function buildEnvVars() {
    const owner = $('cfgOwner').value.replace(/[^0-9]/g, '');
    const botName = $('cfgBotName').value.trim() || 'Knight Bot Mini';
    const prefix = $('cfgPrefix').value || ',';
    const session = $('cfgSession').value.trim();
    const lines = [];
    lines.push(`SESSION_ID=${session || 'KnightBot!H4.....'}`);
    lines.push(`OWNER_NUMBER=${owner || '919876543210'}`);
    lines.push(`BOT_NAME=${botName}`);
    lines.push(`PREFIX=${prefix}`);
    lines.push(`RENDER=true`);
    return lines.join('\n');
  }

  function buildYaml() {
    return `services:
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
        value: "true"`;
  }

  function syntaxHighlight(code) {
    return esc(code)
      .replace(/(\/\/[^\n]*)/g, '<span class="tok-com">$1</span>')
      .replace(/('[^']*')/g, '<span class="tok-str">$1</span>')
      .replace(/\b(true|false|null|undefined|process)\b/g, '<span class="tok-bool">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="tok-num">$1</span>')
      .replace(/([A-Za-z_]\w*)(?=\s*:)/g, '<span class="tok-key">$1</span>');
  }

  function updateConfig() {
    const cfg = buildConfigJS();
    $('configPreview').innerHTML = syntaxHighlight(cfg);
    $('envPreview').textContent = buildEnvVars();
  }

  ['cfgBotName', 'cfgPrefix', 'cfgOwner', 'cfgOwnerName', 'cfgSession', 'cfgPack',
   'cfgAutoRead', 'cfgAutoTyping', 'cfgAutoBio', 'cfgAutoReact', 'cfgSelfMode']
    .forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', updateConfig);
      if (el && el.type === 'checkbox') el.addEventListener('change', updateConfig);
    });

  $('yamlPreview').innerHTML = syntaxHighlight(buildYaml());

  bindCopy('copyConfigBtn', () => buildConfigJS());
  bindCopy('copyEnvBtn', () => buildEnvVars());
  bindCopy('copyYamlBtn', () => buildYaml());

  // Initial render
  updateConfig();
})();
