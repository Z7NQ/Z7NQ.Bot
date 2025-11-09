// index.js
/**
 * System Services Bot
 * - Auto setup on guild join (webhook, private category, channels, role assignment)
 * - Rich embeds + rich presence
 * - Awaiting Commands message
 * - Command handling with prefix '.' and role verification
 * - Render webhook receiver (POST /render-webhook) protected via RENDER_WEBHOOK_SECRET
 *
 * Environment variables required:
 *  - DISCORD_TOKEN
 *  - RENDER_WEBHOOK_SECRET
 *  - PORT (optional, default 3000)
 *
 * Dependencies: discord.js v14, express, dotenv
 */

require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const crypto = require('crypto');

const BOT_NAME = 'System Services';
const PREFIX = '.';
const VERSION = '1.0.0';

// Create the Discord client with required intents to read messages and guild info
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Express app for Render webhooks
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const RENDER_SECRET = process.env.RENDER_WEBHOOK_SECRET || null;

function formatBlock(title, lines) {
  return '```' + `===== ${title} =====\n` + lines.join('\n') + '\n=====`' + '```';
}

// Utility: create a colorful embed with details
function makeDetailedEmbed({ title, description, color = 0x1ABC9C, fields = [], footerText = null, timestamp = true }) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description || '\u200b')
    .setColor(color);

  for (const f of fields) {
    embed.addFields([{ name: f.name || '\u200b', value: f.value || '\u200b', inline: !!f.inline }]);
  }
  if (footerText) embed.setFooter({ text: footerText });
  if (timestamp) embed.setTimestamp();
  return embed;
}

// Helper: find a channel the bot can send to
function findAnySendableChannel(guild) {
  // prefer 'render-console-logs' if exists, otherwise choose first text channel bot can send in
  const preferred = guild.channels.cache.find(c => c.name === 'render-console-logs' && c.type === ChannelType.GuildText);
  if (preferred && preferred.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) return preferred;

  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) {
      return ch;
    }
  }
  return null;
}

// On ready: set rich presence and log
client.once('ready', async () => {
  try {
    await client.user.setPresence({
      activities: [{ name: 'System Services: Online', type: 3 }], // 3 = Watching
      status: 'online'
    });
  } catch (err) {
    console.error('Failed to set presence:', err);
  }
  console.log(`${BOT_NAME} v${VERSION} logged in as ${client.user.tag}`);
  // Post "Awaiting Commands" to each guild in a channel the bot can send to
  for (const guild of client.guilds.cache.values()) {
    const channel = findAnySendableChannel(guild);
    if (channel) {
      try {
        const embed = makeDetailedEmbed({
          title: 'System Services • Status',
          description: '**Awaiting Commands**\nThe bot is online and waiting for commands. Use `.help` for details.',
          color: 0x0E5A8A,
          fields: [
            { name: 'Bot', value: `${BOT_NAME} (v${VERSION})`, inline: true },
            { name: 'Status', value: 'Online', inline: true },
            { name: 'Prefix', value: `\`${PREFIX}\``, inline: true }
          ],
          footerText: 'System Services'
        });
        await channel.send({ embeds: [embed] });
      } catch (err) {
        console.warn('Could not send Awaiting Commands to guild', guild.id, err);
      }
    }
  }
});

// When the bot joins a new guild
client.on('guildCreate', async (guild) => {
  console.log(`Joined guild: ${guild.name} (${guild.id})`);
  const logLines = [
    `Guild Name: ${guild.name}`,
    `Guild ID: ${guild.id}`,
    `Joining time: ${new Date().toISOString()}`
  ];

  try {
    // 1) Create a webhook named "System Services" in the system channel or first sendable text channel
    let systemChannel = guild.systemChannel;
    if (!systemChannel) {
      systemChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.ManageWebhooks));
    }
    if (systemChannel) {
      try {
        await systemChannel.createWebhook({ name: 'System Services', reason: 'Auto-created webhook by System Services bot' });
        logLines.push('Created webhook: System Services');
      } catch (err) {
        logLines.push(`Failed to create webhook in ${systemChannel.name}: ${err.message}`);
      }
    } else {
      logLines.push('No suitable channel found to create webhook.');
    }

    // 2) Create private category "System Services Status"
    const everyoneRole = guild.roles.everyone;
    const category = await guild.channels.create({
      name: 'System Services Status',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: everyoneRole.id,
          deny: [PermissionsBitField.Flags.ViewChannel]
        }
      ],
      reason: 'Auto-created category for system services'
    });
    logLines.push('Created category: System Services Status');

    // 3) Create text channels in that category
    const channelNames = [
      'render-console-logs',
      'render-errors',
      'render-failed',
      'render-status',
      'bot-status'
    ];
    const createdChannels = {};
    for (const name of channelNames) {
      try {
        const ch = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            {
              id: everyoneRole.id,
              deny: [PermissionsBitField.Flags.ViewChannel]
            },
            {
              id: guild.members.me.roles.highest.id,
              allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages]
            }
          ],
          reason: 'Auto-created system channel'
        });
        createdChannels[name] = ch;
        logLines.push(`Created channel: ${name}`);
      } catch (err) {
        logLines.push(`Failed to create channel ${name}: ${err.message}`);
      }
    }

    // 4) Create role "System Services Manager" with Administrator
    const managerRole = await guild.roles.create({
      name: 'System Services Manager',
      color: '#000000',
      permissions: [PermissionsBitField.Flags.Administrator],
      reason: 'Role for system services management'
    });
    logLines.push('Created role: System Services Manager (Administrator)');

    // 5) Assign role to the person who added the bot (audit logs)
    try {
      const audit = await guild.fetchAuditLogs({ type: 28, limit: 1 }); // 28 = BOT_ADD
      const entry = audit.entries.first();
      if (entry && entry.executor) {
        try {
          const member = await guild.members.fetch(entry.executor.id);
          if (member) {
            await member.roles.add(managerRole);
            logLines.push(`Assigned System Services Manager to ${member.user.tag}`);
          } else {
            logLines.push('Could not fetch member who added the bot.');
          }
        } catch (err) {
          logLines.push(`Failed to assign role to adder: ${err.message}`);
        }
      } else {
        logLines.push('No BOT_ADD entry found in audit logs; role not auto-assigned.');
      }
    } catch (err) {
      logLines.push(`Failed to fetch audit logs: ${err.message}`);
    }

    // 6) Send formatted setup log into render-console-logs (if available)
    const consoleChannel = createdChannels['render-console-logs'] || findAnySendableChannel(guild);
    if (consoleChannel) {
      try {
        await consoleChannel.send(formatBlock('LOGGING', logLines));
      } catch (err) {
        console.warn('Failed to send setup log to render-console-logs:', err);
      }
    } else {
      console.warn('No channel available to send setup logs in guild', guild.id);
    }

    // 7) Post "Awaiting Commands" to bot-status channel (if exists) or any sendable one
    const statusChannel = createdChannels['bot-status'] || findAnySendableChannel(guild);
    if (statusChannel) {
      const awaitingEmbed = makeDetailedEmbed({
        title: 'System Services • Bot Status',
        description: '**Awaiting Commands**\nThe bot is online and awaiting commands. Use `.help` for available commands.',
        color: 0x0E5A8A,
        fields: [
          { name: 'Bot', value: `${BOT_NAME} (v${VERSION})`, inline: true },
          { name: 'Prefix', value: `\`${PREFIX}\``, inline: true },
          { name: 'Manager Role', value: managerRole ? `<@&${managerRole.id}>` : 'Not available', inline: true }
        ],
        footerText: 'System Services'
      });
      try {
        await statusChannel.send({ embeds: [awaitingEmbed] });
      } catch (err) {
        console.warn('Could not send Awaiting Commands embed:', err);
      }
    }

    console.log(`Setup complete for guild ${guild.id}`);
  } catch (error) {
    console.error('Error during guildCreate setup:', error);
  }
});

// Command handling
client.on('messageCreate', async (message) => {
  if (!message.guild) return; // don't handle DMs
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [cmdName, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const member = message.member;
  const managerRole = message.guild.roles.cache.find(r => r.name === 'System Services Manager');

  // Role check - require manager role
  if (!managerRole || !member.roles.cache.has(managerRole.id)) {
    // politely deny
    try {
      await message.reply({ embeds: [makeDetailedEmbed({
        title: 'Access Denied',
        description: 'You must have the **System Services Manager** role to use commands.',
        color: 0xE74C3C,
        fields: [{ name: 'Missing Role', value: 'System Services Manager' }],
        footerText: 'Role verification failed'
      })] });
    } catch (err) { console.warn('Failed to send access denied reply:', err); }
    return;
  }

  // Commands
  if (cmdName.toLowerCase() === 'help') {
    // Detailed help embed
    const uptimeMs = Date.now() - client.readyAt.getTime();
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;

    const infoEmbed = makeDetailedEmbed({
      title: 'System Services — Help & Information',
      description: 'A comprehensive command & information panel for System Services bot.',
      color: 0x00BFFF,
      fields: [
        { name: 'Prefix', value: `\`${PREFIX}\``, inline: true },
        { name: 'Version', value: VERSION, inline: true },
        { name: 'Developer', value: 'You (configured in repository)', inline: true },
        { name: 'Host', value: 'Render', inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Primary Role', value: 'System Services Manager (Administrator required)', inline: true },
        { name: '\u200b', value: '\u200b' },

        { name: 'Commands', value:
            '`help` — Shows this help panel\n' +
            '`(Future)` — More commands will be added (e.g., restart, status, logs)'
        },
        { name: 'Information (detailed)', value:
            `**Bot Name:** ${BOT_NAME}\n` +
            `**Purpose:** Auto-setup and monitoring of Render-hosted services via Discord.\n` +
            `**Features:**\n` +
            '- Auto-create webhook, private category & channels\n' +
            '- Create and assign manager role\n' +
            '- Receive and display Render webhook events\n' +
            '- Rich presence and detailed embeds\n' +
            '- Command system with role-based access control\n'
        },
        { name: 'How to Use', value:
            '• Invite the bot with Administrator permissions.\n' +
            '• Ensure environment variables are set on Render: `DISCORD_TOKEN`, `RENDER_WEBHOOK_SECRET`, `PORT`.\n' +
            '• Configure Render webhooks to point to `/render-webhook` with secret.\n' +
            '• Use `.help` to view available commands.'
        }
      ],
      footerText: `Requested by ${message.author.tag}`
    });

    try {
      await message.reply({ embeds: [infoEmbed] });
    } catch (err) {
      console.warn('Failed to send help embed:', err);
    }
    return;
  }

  // Unknown command
  try {
    await message.reply({ embeds: [makeDetailedEmbed({
      title: 'Unknown Command',
      description: `\`${cmdName}\` is not a recognized command.`,
      color: 0xFF8C00,
      fields: [{ name: 'Tip', value: `Use \`${PREFIX}help\` to see available commands.` }],
      footerText: 'System Services'
    })] });
  } catch (err) { console.warn('Failed to send unknown command reply:', err); }
});

// Verify simple secret header for Render webhooks (HMAC optional) — here: compare header to env token
function verifyRenderSecret(req) {
  // Render commonly sends 'X-Render-Signature' or custom header; this implementation expects the secret in header 'x-render-signature'
  const header = (req.headers['x-render-signature'] || req.headers['x-render-signature'] || '').toString();
  if (!RENDER_SECRET) {
    console.warn('No RENDER_WEBHOOK_SECRET configured; skipping verification.');
    return true;
  }
  if (!header) return false;
  // Simple compare (in production use HMAC verification if available)
  return header === RENDER_SECRET;
}

// Render webhook endpoint
app.post('/render-webhook', async (req, res) => {
  try {
    if (!verifyRenderSecret(req)) {
      console.warn('Render webhook: invalid secret header');
      return res.status(403).send('Invalid secret');
    }

    const payload = req.body;
    console.log('Received Render webhook:', JSON.stringify(payload, null, 2));

    // Determine target channels on each guild
    for (const guild of client.guilds.cache.values()) {
      // prefer render-status for regular events, render-errors for failure ones, render-console-logs for verbose logs
      const statusChannel = guild.channels.cache.find(c => c.name === 'render-status' && c.type === ChannelType.GuildText);
      const errorChannel = guild.channels.cache.find(c => c.name === 'render-errors' && c.type === ChannelType.GuildText);
      const consoleChannel = guild.channels.cache.find(c => c.name === 'render-console-logs' && c.type === ChannelType.GuildText);

      // Build a rich embed for the Render event
      const eventType = payload.type || 'unknown_event';
      const title = `Render Event • ${eventType}`;
      const fields = [];

      // Top-level useful fields if present in payload.data
      if (payload.data) {
        if (payload.data.serviceId) fields.push({ name: 'Service ID', value: `${payload.data.serviceId}`, inline: true });
        if (payload.data.serviceName) fields.push({ name: 'Service Name', value: `${payload.data.serviceName}`, inline: true });
        if (payload.data.deployId) fields.push({ name: 'Deploy ID', value: `${payload.data.deployId}`, inline: true });
        if (payload.data.region) fields.push({ name: 'Region', value: `${payload.data.region}`, inline: true });
      }
      fields.push({ name: 'Timestamp', value: payload.timestamp ? `${payload.timestamp}` : `${new Date().toISOString()}` });

      const color = eventType.includes('failed') || eventType.includes('error') ? 0xE74C3C : 0x2ECC71;
      const embed = makeDetailedEmbed({
        title,
        description: 'Detailed Render event payload (summary fields below). Full payload attached as JSON where applicable.',
        color,
        fields
      });

      // Attach abbreviated JSON (if not too large)
      try {
        const shortJson = JSON.stringify(payload.data || payload, null, 2);
        if (shortJson.length < 1800) {
          embed.addFields([{ name: 'Payload', value: `\`\`\`json\n${shortJson}\n\`\`\`` }]);
        } else {
          // too big -> only include summary
          embed.addFields([{ name: 'Payload', value: 'Payload too large to display here. Check Render Dashboard for full logs.' }]);
        }
      } catch (err) {
        // ignore
      }

      // Route messages: failures go to errorChannel, else statusChannel, and always write summary to consoleChannel if exists
      try {
        if (eventType.toLowerCase().includes('fail') || eventType.toLowerCase().includes('error')) {
          if (errorChannel) await errorChannel.send({ embeds: [embed] });
          else if (statusChannel) await statusChannel.send({ embeds: [embed] });
        } else {
          if (statusChannel) await statusChannel.send({ embeds: [embed] });
          else if (consoleChannel) await consoleChannel.send({ embeds: [embed] });
        }

        // also write a plain formatted block to console channel for raw logging
        if (consoleChannel) {
          const lines = [
            `Event: ${eventType}`,
            `Service ID: ${payload.data?.serviceId || 'N/A'}`,
            `Timestamp: ${payload.timestamp || (new Date().toISOString())}`
          ];
          await consoleChannel.send(formatBlock('RENDER WEBHOOK', lines));
        }
      } catch (err) {
        console.warn('Failed to send render webhook embed to guild:', guild.id, err);
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling render-webhook:', err);
    return res.status(500).send('Server error');
  }
});

// Start Express + Discord login
app.listen(PORT, () => {
  console.log(`${BOT_NAME} webhook listener running on port ${PORT}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN missing from environment variables. Exiting.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
