/**
 * Lightweight built-in command handler.
 * Used when the full KnightBot-Mini engine isn't cloned into ./knightbot-engine.
 * Provides a small but functional command set so hosted bots work immediately.
 */

const commands = {
  menu: {
    desc: 'Show the command menu',
    run: (sock, msg, ctx) => {
      const c = ctx.config;
      const list = Object.entries(commands).map(([n, v]) => `  ${c.prefix}${n} — ${v.desc}`).join('\n');
      const text =
        `╭━━「 *${c.botName}* 」━━\n` +
        `┃ 👑 Owner: ${c.ownerName?.[0] || 'Admin'}\n` +
        `┃ ⚡ Prefix: ${c.prefix}\n` +
        `┃ 🟢 Status: Online\n` +
        `╰━━━━━━━━━━━━━━━\n\n` +
        `*Available Commands:*\n${list}\n\n` +
        `> Hosted on KnightBot Multi-Hosting Platform`;
      return sock.sendMessage(ctx.from, { text }, { quoted: msg });
    },
  },
  ping: {
    desc: 'Check bot response time',
    run: async (sock, msg, ctx) => {
      const start = Date.now();
      await sock.sendMessage(ctx.from, { text: '⏳ Pinging...' }, { quoted: msg });
      const text = `🏓 Pong! ${Date.now() - start}ms\n> ${ctx.config.botName}`;
      return sock.sendMessage(ctx.from, { text });
    },
  },
  alive: {
    desc: 'Check if bot is alive',
    run: (sock, msg, ctx) =>
      sock.sendMessage(ctx.from, { text: `✅ *${ctx.config.botName}* is alive and running!\n🟢 Uptime: ${process.uptime().toFixed(0)}s` }, { quoted: msg }),
  },
  sticker: {
    desc: 'Convert image to sticker (reply to image)',
    run: async (sock, msg, ctx) => {
      const q = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
      if (!q) return sock.sendMessage(ctx.from, { text: '❌ Reply to an image with this command.' }, { quoted: msg });
      try {
        const stream = await sock.downloadMediaContent?.(q) || await sock.downloadAndSaveMediaContent?.(q);
        return sock.sendMessage(ctx.from, { sticker: { url: stream } }, { quoted: msg });
      } catch (e) {
        return sock.sendMessage(ctx.from, { text: '❌ Could not create sticker: ' + e.message }, { quoted: msg });
      }
    },
  },
  info: {
    desc: 'Show bot info',
    run: (sock, msg, ctx) => {
      const c = ctx.config;
      return sock.sendMessage(ctx.from, {
        text: `ℹ️ *Bot Information*\n\n*Name:* ${c.botName}\n*Prefix:* ${c.prefix}\n*Owner:* ${c.ownerName?.[0] || 'Admin'}\n*Platform:* KnightBot Multi-Hosting\n*Uptime:* ${process.uptime().toFixed(0)}s`,
      }, { quoted: msg });
    },
  },
};

function isOwner(sender, config) {
  if (!sender) return false;
  const num = sender.split('@')[0].split(':')[0];
  return (config.ownerNumber || []).some((o) => String(o).replace(/[^0-9]/g, '') === num);
}

async function handleMessage(sock, msg, config) {
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  const sender = msg.key.fromMe
    ? sock.user?.id?.split(':')[0] + '@s.whatsapp.net'
    : msg.key.participant || from;

  let body = '';
  const m = msg.message;
  if (m.conversation) body = m.conversation;
  else if (m.extendedTextMessage) body = m.extendedTextMessage.text || '';
  else if (m.imageMessage) body = m.imageMessage.caption || '';
  else if (m.videoMessage) body = m.videoMessage.caption || '';
  body = (body || '').trim();

  if (!body.startsWith(config.prefix)) return;

  const args = body.slice(config.prefix.length).trim().split(/\s+/);
  const name = args.shift().toLowerCase();
  const cmd = commands[name];
  if (!cmd) return;

  if (config.selfMode && !isOwner(sender, config)) return;

  const ctx = { from, sender, config, args };
  try {
    await cmd.run(sock, msg, ctx);
  } catch (e) {
    console.error(`Command "${name}" error:`, e.message);
  }
}

async function handleGroupUpdate(sock, update, config) {
  // Minimal: no-op for the lite handler. Full engine handles welcome/goodbye.
}

module.exports = { handleMessage, handleGroupUpdate, commands };
