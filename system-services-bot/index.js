/**
 * index.js — System Services (production ready)
 *
 * Features:
 *  - Auto-setup on guild join: webhook, private category, channels, role assignment
 *  - Permission checks and detailed error handling
 *  - Colorful embeds and formatted log blocks (===== ... =====)
 *  - Rotating rich presence ("System Services: Online", etc.)
 *  - Awaiting Commands message posted on startup & after setup
 *  - Command handler with prefix '.' and role verification
 *  - .help command with super-detailed Information section
 *  - Render webhook endpoint with HMAC-SHA256 verification (header: x-render-signature)
 *  - Optional persistence of guild channel IDs in data/guildSettings.json
 *
 * Environment variables (set in Render):
 *  - DISCORD_TOKEN
 *  - RENDER_WEBHOOK_SECRET
 *  - PORT (optional, default 3000)
 *
 * Dependencies:
 *  - discord.js (v14)
 *  - express
 *  - dotenv
 *  - fs (node built-in)
 *  - crypto (node built-in)
 *
 * Notes:
 *  - Invite the bot with Manage Channels, Manage Roles, Manage Webhooks, Send Messages
 *  - For HMAC verification: Render must provide the raw body signature in header 'x-render-signature'
 *    which should equal HMAC_SHA256(rawBody, RENDER_WEBHOOK_SECRET). If Render uses a different header,
 *    update VERIFY_HEADER variable accordingly.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  Colors
} = require('discord.js');

const BOT_NAME = 'System Services';
const PREFIX = '.';
const VERSION = '1.1.0';
const DATA_DIR = path.join(__dirname, 'data');
const GUILD_SETTINGS_FILE = path.join(DATA_DIR, 'guildSettings.json');
const PRESENCE_UPDATE_INTERVAL_MS = 20_000; // 20 seconds
const VERIFY_HEADER = 'x-render-signature'; // header expected from Render; adjust if needed

// create data directory if missing
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR);
  } catch (err) {
    console.warn('Could not create data directory, persistence disabled:', err.message);
  }
}

// load persistent guild settings (best-effort)
let guildSettings = {};
try {
  if (fs.existsSync(GUILD_SETTINGS_FILE)) {
    const raw = fs.readFileSync(GUILD_SETTINGS_FILE, 'utf8');
    guildSettings = JSON.parse(raw);
  }
} catch (err) {
  console.warn('Failed to load guild settings:', err.message);
  guildSettings = {};
}
function persistGuildSettings() {
  try {
    fs.writeFileSync(GUILD_SETTINGS_FILE, JSON.stringify(guildSettings, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to persist guild settings:', err.message);
  }
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Express (we need raw body for HMAC verification)
const app = express();

// Raw body capture middleware for webhook verification
app.use((req, res, next) => {
  let data = [];
  req.on('data', (chunk) => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data);
    try {
      // try to parse JSON body into req.body (fallback)
      if (req.rawBody && req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
        req.body = JSON.parse(req.rawBody.toString('utf8'));
      } else {
        req.body = {};
      }
    } catch (err) {
      req.body = {};
    }
    next();
  });
});

// helpers
function logConsoleBlock(title, lines) {
  console.log('===== ' + title + ' =====');
  lines.forEach(l => console.log(l));
  console.log('=======================');
}

function formatBlock(title, lines) {
  return '```' + `===== ${title} =====\n` + lines.join('\n') + '\n=====`' + '```';
}

function makeEmbed({ title = '', description = '', color = 0x2ECC71, fields = [], footer = null }) {
  const e = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  if (fields && fields.length) {
    const safeFields = fields.map(f => ({ name: f.name || '\u200b', value: f.value || '\u200b', inline: !!f.inline }));
    e.addFields(safeFields);
  }
  if (footer) e.setFooter({ text: footer });
  return e;
}

function findSendableChannel(guild) {
  // prefer stored channel IDs (render-console-logs), else any text channel bot can send to
  const saved = guildSettings[guild.id]?.renderConsoleLogsChannelId;
  if (saved) {
    const ch = guild.channels.cache.get(saved);
    if (ch && ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) {
      return ch;
    }
  }
  const preferred = guild.channels.cache.find(c => c.name === 'render-console-logs' && c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages));
  if (preferred) return preferred;
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) return ch;
  }
  return null;
}

async function trySendLog(guild, title, lines) {
  try {
    const ch = findSendableChannel(guild);
    if (!ch) return false;
    await ch.send(formatBlock(title, lines));
    return true;
  } catch (err) {
    console.warn('Failed to send log block to guild', guild.id, err.message);
    return false;
  }
}

// presence rotation
const presenceOptions = [
  { name: 'System Services: Online', type: 3 }, // Watching
  { name: 'Monitoring Render Deploys', type: 3 },
  { name: 'Awaiting Commands', type: 3 },
  { name: 'Managing System Services', type: 3 },
];

let presenceIndex = 0;
function rotatePresence() {
  try {
    const p = presenceOptions[presenceIndex % presenceOptions.length];
    client.user.setPresence({ activities: [{ name: p.name, type: p.type }], status: 'online' }).catch(() => {});
    presenceIndex++;
  } catch (err) {
    console.warn('Presence rotation failed:', err.message);
  }
}

// robust setup function for a guild
async function performAutoSetup(guild) {
  const logLines = [];
  logLines.push(`Guild Name: ${guild.name}`);
  logLines.push(`Guild ID: ${guild.id}`);
  logLines.push(`Timestamp: ${new Date().toISOString()}`);

  // check essential permissions
  const missingPerms = [];
  const meMember = guild.members.me;
  if (!meMember) {
    logLines.push('Failed to get bot member info; aborting setup.');
    await trySendLog(guild, 'LOGGING', logLines);
    return;
  }

  const reqPerms = ['ManageChannels', 'ManageRoles', 'ManageWebhooks', 'SendMessages', 'ViewChannel'];
  const botPerms = meMember.permissions;
  for (const p of reqPerms) {
    if (!botPerms.has(PermissionsBitField.Flags[p])) {
      missingPerms.push(p);
    }
  }
  if (missingPerms.length) {
    logLines.push(`Warning: Bot may be missing required permissions: ${missingPerms.join(', ')}`);
    await trySendLog(guild, 'LOGGING', logLines);
    // proceed but note failures will occur
  }

  // 1) Create webhook in system channel or first channel we can manage webhooks in
  let systemChannel = guild.systemChannel;
  if (!systemChannel) {
    systemChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(meMember).has(PermissionsBitField.Flags.ManageWebhooks));
  }
  if (systemChannel) {
    try {
      await systemChannel.createWebhook({ name: 'System Services', reason: 'Auto-created webhook' });
      logLines.push(`Created webhook "System Services" in channel ${systemChannel.name}`);
    } catch (err) {
      logLines.push(`Failed to create webhook in ${systemChannel.name}: ${err.message}`);
    }
  } else {
    logLines.push('No suitable channel to create webhook.');
  }

  // 2) Create private category
  const everyone = guild.roles.everyone;
  let category;
  try {
    category = await guild.channels.create({
      name: 'System Services Status',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: meMember.roles.highest.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ManageChannels] }
      ],
      reason: 'Auto-created category for system services'
    });
    logLines.push('Created category: System Services Status');
  } catch (err) {
    logLines.push('Failed to create category: ' + err.message);
  }

  // 3) Create channels
  const channelsToCreate = [
    { name: 'render-console-logs', purpose: 'Detailed formatted logs & startup output' },
    { name: 'render-errors', purpose: 'Render errors & failure events' },
    { name: 'render-failed', purpose: 'Failed deploys & critical alerts' },
    { name: 'render-status', purpose: 'Deploy status & info' },
    { name: 'bot-status', purpose: 'Bot health & awaiting commands messages' }
  ];
  const created = {};
  for (const spec of channelsToCreate) {
    try {
      const ch = await guild.channels.create({
        name: spec.name,
        type: ChannelType.GuildText,
        parent: category ? category.id : undefined,
        permissionOverwrites: [
          { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: meMember.roles.highest.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages] }
        ],
        reason: 'Auto-created system channel'
      });
      created[spec.name] = ch;
      logLines.push(`Created channel: ${spec.name} (${spec.purpose})`);
    } catch (err) {
      logLines.push(`Failed to create channel ${spec.name}: ${err.message}`);
    }
  }

  // Persist console log channel id for future
  if (created['render-console-logs']) {
    guildSettings[guild.id] = guildSettings[guild.id] || {};
    guildSettings[guild.id].renderConsoleLogsChannelId = created['render-console-logs'].id;
    persistGuildSettings();
  }

  // 4) Create role with Administrator
  let managerRole = guild.roles.cache.find(r => r.name === 'System Services Manager');
  if (!managerRole) {
    try {
      managerRole = await guild.roles.create({
        name: 'System Services Manager',
        color: '#000000',
        permissions: [PermissionsBitField.Flags.Administrator],
        reason: 'System Services Manager role'
      });
      logLines.push('Created role: System Services Manager (Administrator)');
    } catch (err) {
      logLines.push('Failed to create manager role: ' + err.message);
    }
  } else {
    logLines.push('Manager role already exists: ' + managerRole.id);
  }

  // 5) Attempt to assign role to who added the bot via audit logs
  try {
    const audit = await guild.fetchAuditLogs({ type: 28, limit: 1 }); // BOT_ADD
    const entry = audit.entries.first();
    if (entry?.executor) {
      const executorId = entry.executor.id;
      try {
        const member = await guild.members.fetch(executorId);
        if (member && managerRole) {
          await member.roles.add(managerRole);
          logLines.push(`Assigned role to ${member.user.tag}`);
        } else {
          logLines.push('Could not assign role — member or manager role missing.');
        }
      } catch (err) {
        logLines.push(`Failed to assign role to adder (${executorId}): ${err.message}`);
      }
    } else {
      logLines.push('No BOT_ADD audit log entry found; could not auto-assign role.');
    }
  } catch (err) {
    logLines.push('Error fetching audit logs: ' + err.message);
  }

  // Send setup embed + block to render-console-logs
  const primaryLogChannel = created['render-console-logs'] || findSendableChannel(guild);
  if (primaryLogChannel) {
    const embed = makeEmbed({
      title: 'System Services — Auto Setup Summary',
      description: `Automatic setup completed for **${guild.name}**. See details below.`,
      color: 0x0E5A8A,
      fields: [
        { name: 'Created Channels', value: channelsToCreate.map(c => `• ${c.name}`).join('\n') },
        { name: 'Manager Role', value: managerRole ? `<@&${managerRole.id}>` : 'Not created', inline: true },
        { name: 'Webhook', value: systemChannel ? `Attempted in ${systemChannel.name}` : 'No target channel' }
      ],
      footer: 'System Services'
    });
    try {
      await primaryLogChannel.send({ embeds: [embed] });
      await primaryLogChannel.send(formatBlock('LOGGING', logLines));
    } catch (err) {
      console.warn('Failed to post setup embed/block:', err.message);
    }
  } else {
    logConsoleBlock('LOGGING', logLines);
  }

  // Post "Awaiting Commands" to bot-status
  const statusTarget = created['bot-status'] || findSendableChannel(guild);
  if (statusTarget) {
    const awaitingEmbed = makeEmbed({
      title: 'System Services • Bot Status',
      description: '**Awaiting Commands**\nThe bot is online and ready. Use `.help` to view commands.',
      color: 0x00BFFF,
      fields: [
        { name: 'Bot', value: `${BOT_NAME} (v${VERSION})`, inline: true },
        { name: 'Prefix', value: `\`${PREFIX}\``, inline: true },
        { name: 'Manager Role', value: managerRole ? `<@&${managerRole.id}>` : 'Not available', inline: true }
      ],
      footer: 'System Services'
    });
    try {
      await statusTarget.send({ embeds: [awaitingEmbed] });
    } catch (err) {
      console.warn('Could not send Awaiting Commands embed:', err.message);
    }
  }

  return { created, managerRole, category };
}

// send a short rich embed status when Render webhooks arrive
async function dispatchRenderEventToGuild(guild, payload) {
  try {
    const statusChannel = guild.channels.cache.find(c => c.name === 'render-status' && c.type === ChannelType.GuildText);
    const errorChannel = guild.channels.cache.find(c => c.name === 'render-errors' && c.type === ChannelType.GuildText);
    const consoleChannel = guild.channels.cache.find(c => c.name === 'render-console-logs' && c.type === ChannelType.GuildText);

    const eventType = payload.type || 'unknown';
    const title = `Render Event • ${eventType}`;
    const fields = [];
    if (payload.data) {
      if (payload.data.serviceName) fields.push({ name: 'Service', value: String(payload.data.serviceName), inline: true });
      if (payload.data.serviceId) fields.push({ name: 'Service ID', value: String(payload.data.serviceId), inline: true });
      if (payload.data.deployId) fields.push({ name: 'Deploy ID', value: String(payload.data.deployId), inline: true });
    }
    fields.push({ name: 'Timestamp', value: payload.timestamp || new Date().toISOString(), inline: true });

    const isError = eventType.toLowerCase().includes('fail') || eventType.toLowerCase().includes('error') || eventType.toLowerCase().includes('crash');
    const embed = makeEmbed({
      title,
      description: `Render sent event **${eventType}**. Summary below.`,
      color: isError ? 0xE74C3C : 0x2ECC71,
      fields
    });

    // attach payload snippet if small
    try {
      const shortJson = JSON.stringify(payload.data || payload, null, 2);
      if (shortJson.length < 1500) {
        embed.addFields([{ name: 'Payload (excerpt)', value: `\`\`\`json\n${shortJson}\n\`\`\`` }]);
      } else {
        embed.addFields([{ name: 'Payload', value: 'Payload too large to display. Check Render Dashboard.' }]);
      }
    } catch (err) {
      // ignore
    }

    // send to appropriate channel(s)
    if (isError) {
      if (errorChannel) await errorChannel.send({ embeds: [embed] });
      else if (statusChannel) await statusChannel.send({ embeds: [embed] });
    } else {
      if (statusChannel) await statusChannel.send({ embeds: [embed] });
      else if (consoleChannel) await consoleChannel.send({ embeds: [embed] });
    }

    // also log to console channel
    if (consoleChannel) {
      await consoleChannel.send(formatBlock('RENDER WEBHOOK', [
        `Event: ${eventType}`,
        `Service ID: ${payload.data?.serviceId || 'N/A'}`,
        `Timestamp: ${payload.timestamp || new Date().toISOString()}`
      ]));
    }

    return true;
  } catch (err) {
    console.warn('Failed to dispatch render event to guild:', guild.id, err.message);
    return false;
  }
}

// On guild join: run setup
client.on('guildCreate', async (guild) => {
  try {
    await performAutoSetup(guild);
  } catch (err) {
    console.error('guildCreate handler error:', err);
  }
});

// On ready: presence rotation, post awaiting commands to each guild if possible
client.once('ready', async () => {
  console.log(`${BOT_NAME} v${VERSION} logged in as ${client.user.tag}`);
  rotatePresence();
  setInterval(rotatePresence, PRESENCE_UPDATE_INTERVAL_MS);

  for (const guild of client.guilds.cache.values()) {
    const channel = findSendableChannel(guild);
    if (channel) {
      try {
        await channel.send({ embeds: [makeEmbed({
          title: 'System Services • Startup',
          description: '**Awaiting Commands**\nBot started and ready. Use `.help` for details.',
          color: 0x0E5A8A,
          fields: [
            { name: 'Bot', value: `${BOT_NAME} (v${VERSION})`, inline: true },
            { name: 'Prefix', value: `\`${PREFIX}\``, inline: true }
          ],
          footer: 'System Services'
        })] });
      } catch (err) {
        // ignore
      }
    }
  }
});

// Command handler with role check
client.on('messageCreate', async (message) => {
  if (!message.guild) return; // ignore DMs
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  // Role verification
  const managerRole = message.guild.roles.cache.find(r => r.name === 'System Services Manager');
  if (!managerRole) {
    // If role missing, tell user admin to re-run setup
    return message.reply({ embeds: [makeEmbed({
      title: 'Configuration Missing',
      description: 'System Services Manager role is missing. Please ensure the bot has created it or run setup again.',
      color: 0xFF8C00,
      footer: 'System Services'
    })] });
  }
  if (!message.member.roles.cache.has(managerRole.id)) {
    return message.reply({ embeds: [makeEmbed({
      title: 'Access Denied',
      description: 'You must have the **System Services Manager** role to execute commands.',
      color: 0xE74C3C,
      fields: [{ name: 'Missing Role', value: 'System Services Manager' }],
      footer: 'Role-based access control'
    })] });
  }

  // commands
  if (cmd === 'help') {
    const uptimeMs = Date.now() - (client.readyAt ? client.readyAt.getTime() : Date.now());
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;

    const helpEmbed = makeEmbed({
      title: 'System Services — Help & Information',
      description: 'Comprehensive control panel for the System Services bot. Commands require the **System Services Manager** role.',
      color: 0x0099FF,
      fields: [
        { name: 'Prefix', value: `\`${PREFIX}\``, inline: true },
        { name: 'Version', value: VERSION, inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: '\u200b', value: '\u200b' },
        { name: '**Commands**', value:
            `\`${PREFIX}help\` — Show this help & information panel\n` +
            `\`${PREFIX}info\` — Show detailed bot information (same as Information section)\n` +
            `\`${PREFIX}setup\` — Re-run automatic setup (re-creates missing channels/role)\n` +
            `\`${PREFIX}ping\` — Latency check\n` +
            `\`${PREFIX}whoami\` — Shows your user & role info\n`
        },
        { name: 'Information (detailed)', value:
            `**Name:** ${BOT_NAME}\n` +
            `**Purpose:** Automate server setup for Render monitoring and forward Render webhook events into Discord.\n` +
            `**Hosting:** Render — the bot listens for Render webhook POSTs at \`/render-webhook\`.\n` +
            `**Permissions**: Manage Channels, Manage Roles, Manage Webhooks, Send Messages (required for setup).\n` +
            `**Security**: Webhook verification via HMAC-SHA256 using RENDER_WEBHOOK_SECRET (header ${VERIFY_HEADER}).\n`
        },
        { name: 'Getting Started', value:
            '• Invite the bot with Administrator or the listed permissions.\n' +
            '• Add environment variables on Render: `DISCORD_TOKEN`, `RENDER_WEBHOOK_SECRET`, `PORT=3000`.\n' +
            '• Create a Render webhook for your service → POST to:\n' +
            `  \`https://<your-service>.onrender.com/render-webhook\` with header \`${VERIFY_HEADER}\` = your secret.\n`
        },
        { name: 'Notes & Limitations', value:
            '- The bot posts summarized Render events. Full live streaming of service logs requires Render log streaming integrations.\n' +
            '- Guild-specific settings are persisted in repository `data/guildSettings.json` (ephemeral on some hosts).'
        }
      ],
      footer: 'System Services — Help'
    });

    return message.reply({ embeds: [helpEmbed] });
  }

  if (cmd === 'info') {
    // replicate main information panel
    const info = makeEmbed({
      title: 'System Services — Information',
      description: `Detailed system information for **${BOT_NAME}**.`,
      color: 0x00BFFF,
      fields: [
        { name: 'Bot Name', value: BOT_NAME, inline: true },
        { name: 'Version', value: VERSION, inline: true },
        { name: 'Host', value: 'Render', inline: true },
        { name: 'Developer', value: 'You (configure repository)', inline: true },
        { name: 'Prefix', value: `\`${PREFIX}\``, inline: true },
        { name: 'Required Role', value: 'System Services Manager', inline: true },
        { name: 'Uptime', value: client.readyAt ? `${Math.floor((Date.now() - client.readyAt.getTime())/1000)}s` : 'N/A', inline: true },
      ],
      footer: 'System Services'
    });
    return message.reply({ embeds: [info] });
  }

  if (cmd === 'ping') {
    const sent = await message.reply({ content: 'Pinging...' });
    const latency = sent.createdTimestamp - message.createdTimestamp;
    return sent.edit({ embeds: [makeEmbed({
      title: 'Pong!',
      description: `Latency: \`${latency}ms\`\nAPI: \`${Math.round(client.ws.ping)}ms\``,
      color: 0x2ECC71,
      footer: 'System Services'
    })] });
  }

  if (cmd === 'setup') {
    // re-run setup
    await message.reply({ embeds: [makeEmbed({ title: 'Setup', description: 'Re-running automatic setup. This may create missing channels/roles.', color: 0xF1C40F })] });
    try {
      await performAutoSetup(message.guild);
      return message.reply({ embeds: [makeEmbed({ title: 'Setup Complete', description: 'Automatic setup finished. Check the render-console-logs for details.', color: 0x00BFFF })] });
    } catch (err) {
      return message.reply({ embeds: [makeEmbed({ title: 'Setup Error', description: `Error: ${err.message}`, color: 0xE74C3C })] });
    }
  }

  if (cmd === 'whoami') {
    const roles = message.member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') || 'None';
    return message.reply({ embeds: [makeEmbed({
      title: 'User Info',
      description: `${message.author.tag} (${message.author.id})`,
      color: 0x3498DB,
      fields: [
        { name: 'Roles', value: roles },
        { name: 'Joined Server', value: message.member.joinedAt ? message.member.joinedAt.toISOString() : 'N/A' }
      ],
      footer: 'System Services'
    })] });
  }

  // unknown command
  return message.reply({ embeds: [makeEmbed({
    title: 'Unknown Command',
    description: `Command \`${cmd}\` not found. Use \`${PREFIX}help\` to view commands.`,
    color: 0xFF8C00
  })] });

});

// Verify Render webhook HMAC-SHA256 signature
function verifyRenderWebhook(req) {
  const secret = process.env.RENDER_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('RENDER_WEBHOOK_SECRET not configured; skipping verification (insecure).');
    return true;
  }
  const headerSig = (req.headers[VERIFY_HEADER] || '').toString();
  if (!headerSig) return false;

  try {
    // HMAC-SHA256
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.rawBody || Buffer.from(''));
    const digest = hmac.digest('hex');
    // constant-time compare
    const headerNormalized = headerSig.startsWith('sha256=') ? headerSig.split('=')[1] : headerSig;
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(headerNormalized, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (err) {
    console.warn('Webhook verification failed:', err.message);
    return false;
  }
}

// Render webhook endpoint
app.post('/render-webhook', async (req, res) => {
  try {
    if (!verifyRenderWebhook(req)) {
      logConsoleBlock('RENDER WEBHOOK', ['Invalid or missing signature header.']);
      return res.status(403).send('Invalid signature');
    }

    const payload = req.body || {};
    logConsoleBlock('RENDER WEBHOOK', [`Received render webhook: ${payload.type || 'unknown'}`, JSON.stringify(payload.data || payload).slice(0, 500)]);

    // broadcast to all guilds where bot is present
    for (const guild of client.guilds.cache.values()) {
      try {
        await dispatchRenderEventToGuild(guild, payload);
      } catch (err) {
        console.warn('Failed to dispatch event to guild', guild.id, err.message);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error in /render-webhook:', err);
    return res.status(500).send('Server error');
  }
});

// start express server & login bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${BOT_NAME} webhook listener running on port ${PORT}`));

// login
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not set in environment — exiting.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Discord login failed:', err);
  process.exit(1);
});
