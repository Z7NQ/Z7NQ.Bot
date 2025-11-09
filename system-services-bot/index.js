/**
 * index.js — System Services Bot (Base)
 *
 * Core features:
 *  - Guild auto-setup (category, channels, role)
 *  - Presence rotation
 *  - Render webhook listener with HMAC verification
 *  - Persistent guild settings
 *  - Logging to dedicated channels
 *
 * Dependencies: discord.js v14, express, dotenv
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
  EmbedBuilder
} = require('discord.js');

const BOT_NAME = 'System Services';
const PREFIX = '.';
const VERSION = '1.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const GUILD_SETTINGS_FILE = path.join(DATA_DIR, 'guildSettings.json');
const PRESENCE_UPDATE_INTERVAL_MS = 20000;
const VERIFY_HEADER = 'x-render-signature';

// create data dir if missing
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// load guild settings
let guildSettings = {};
try {
  if (fs.existsSync(GUILD_SETTINGS_FILE)) {
    guildSettings = JSON.parse(fs.readFileSync(GUILD_SETTINGS_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('Failed to load guild settings:', err.message);
}

// persist guild settings
function persistGuildSettings() {
  try {
    fs.writeFileSync(GUILD_SETTINGS_FILE, JSON.stringify(guildSettings, null, 2));
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

// Express for webhook listener
const app = express();
app.use((req, res, next) => {
  let data = [];
  req.on('data', chunk => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data);
    try {
      if (req.rawBody && req.headers['content-type']?.includes('application/json')) {
        req.body = JSON.parse(req.rawBody.toString('utf8'));
      } else req.body = {};
    } catch {
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
  if (fields.length) {
    const safeFields = fields.map(f => ({ name: f.name || '\u200b', value: f.value || '\u200b', inline: !!f.inline }));
    e.addFields(safeFields);
  }
  if (footer) e.setFooter({ text: footer });
  return e;
}

function findSendableChannel(guild) {
  const saved = guildSettings[guild.id]?.renderConsoleLogsChannelId;
  if (saved) {
    const ch = guild.channels.cache.get(saved);
    if (ch?.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)) return ch;
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
  } catch {
    return false;
  }
}

// presence rotation
const presenceOptions = [
  { name: 'System Services: Online', type: 3 },
  { name: 'Monitoring Render Deploys', type: 3 },
  { name: 'Awaiting Commands', type: 3 },
  { name: 'Managing System Services', type: 3 }
];

let presenceIndex = 0;
function rotatePresence() {
  try {
    const p = presenceOptions[presenceIndex % presenceOptions.length];
    client.user.setPresence({ activities: [{ name: p.name, type: p.type }], status: 'online' }).catch(() => {});
    presenceIndex++;
  } catch {}
}

// auto setup
async function performAutoSetup(guild) {
  const logLines = [`Guild: ${guild.name} (${guild.id})`, `Time: ${new Date().toISOString()}`];
  const meMember = guild.members.me;

  if (!meMember) {
    logLines.push('Bot member missing.');
    await trySendLog(guild, 'LOGGING', logLines);
    return;
  }

  const reqPerms = ['ManageChannels', 'ManageRoles', 'ManageWebhooks', 'SendMessages', 'ViewChannel'];
  const missingPerms = reqPerms.filter(p => !meMember.permissions.has(PermissionsBitField.Flags[p]));
  if (missingPerms.length) logLines.push(`Missing permissions: ${missingPerms.join(', ')}`);

  // create webhook
  let systemChannel = guild.systemChannel || guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(meMember).has(PermissionsBitField.Flags.ManageWebhooks));
  if (systemChannel) {
    try { await systemChannel.createWebhook({ name: 'System Services', reason: 'Auto-created' }); logLines.push(`Created webhook in ${systemChannel.name}`); } 
    catch (err) { logLines.push(`Webhook failed: ${err.message}`); }
  }

  // create category
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
      reason: 'Auto category'
    });
    logLines.push('Created category System Services Status');
  } catch (err) { logLines.push('Category failed: ' + err.message); }

  // create basic channels
  const channelsToCreate = [
    { name: 'render-console-logs', purpose: 'Logs' },
    { name: 'render-errors', purpose: 'Errors' },
    { name: 'render-status', purpose: 'Status' },
    { name: 'bot-status', purpose: 'Bot status' }
  ];
  const created = {};
  for (const spec of channelsToCreate) {
    try {
      const ch = await guild.channels.create({
        name: spec.name,
        type: ChannelType.GuildText,
        parent: category?.id,
        permissionOverwrites: [
          { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: meMember.roles.highest.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ],
        reason: 'Auto channel'
      });
      created[spec.name] = ch;
      logLines.push(`Created channel: ${spec.name}`);
    } catch (err) { logLines.push(`Channel ${spec.name} failed: ${err.message}`); }
  }

  if (created['render-console-logs']) {
    guildSettings[guild.id] = guildSettings[guild.id] || {};
    guildSettings[guild.id].renderConsoleLogsChannelId = created['render-console-logs'].id;
    persistGuildSettings();
  }

  // role
  let managerRole = guild.roles.cache.find(r => r.name === 'System Services Manager');
  if (!managerRole) {
    try {
      managerRole = await guild.roles.create({
        name: 'System Services Manager',
        color: '#000000',
        permissions: [PermissionsBitField.Flags.Administrator],
        reason: 'Manager role'
      });
      logLines.push('Created role System Services Manager');
    } catch (err) { logLines.push('Role failed: ' + err.message); }
  } else logLines.push('Manager role exists');

  // send setup logs
  const primaryLogChannel = created['render-console-logs'] || findSendableChannel(guild);
  if (primaryLogChannel) await primaryLogChannel.send(formatBlock('SETUP LOG', logLines));
}

// Render webhook verification
function verifyRenderWebhook(req) {
  const secret = process.env.RENDER_WEBHOOK_SECRET;
  if (!secret) return true;
  const headerSig = (req.headers[VERIFY_HEADER] || '').toString();
  if (!headerSig) return false;
  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(req.rawBody || Buffer.from(''));
    const digest = hmac.digest('hex');
    const headerNormalized = headerSig.startsWith('sha256=') ? headerSig.split('=')[1] : headerSig;
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(headerNormalized, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

// Render webhook endpoint
app.post('/render-webhook', async (req, res) => {
  try {
    if (!verifyRenderWebhook(req)) return res.status(403).send('Invalid signature');
    const payload = req.body || {};
    logConsoleBlock('RENDER WEBHOOK', [`Received: ${payload.type || 'unknown'}`]);
    for (const guild of client.guilds.cache.values()) {
      // dispatch events to guilds — command handling will be implemented later
    }
    return res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
  }
});

// start express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${BOT_NAME} webhook listener running on port ${PORT}`));

// on guild join
client.on('guildCreate', guild => performAutoSetup(guild));

// presence rotation
client.once('ready', () => {
  console.log(`${BOT_NAME} v${VERSION} logged in as ${client.user.tag}`);
  rotatePresence();
  setInterval(rotatePresence, PRESENCE_UPDATE_INTERVAL_MS);
  for (const guild of client.guilds.cache.values()) performAutoSetup(guild);
});

// login
if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN not set — exiting.');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN).catch(err => { console.error('Discord login failed:', err); process.exit(1); });
// ===============================
// MANAGE SERVER COMMANDS
// ===============================

const manageServerCommands = {
  // 1. Server Info
  serverinfo: async (message) => {
    const { guild } = message;
    const embed = makeEmbed({
      title: 'Server Info',
      fields: [
        { name: 'Server Name', value: guild.name, inline: true },
        { name: 'Server ID', value: guild.id, inline: true },
        { name: 'Total Members', value: guild.memberCount.toString(), inline: true },
        { name: 'Created At', value: guild.createdAt.toDateString(), inline: true },
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true }
      ]
    });
    await message.channel.send({ embeds: [embed] });
  },

  // 2. List Channels
  listchannels: async (message) => {
    const channelList = message.guild.channels.cache.map(c => `${c.name} (${c.type})`).join('\n');
    await message.channel.send(formatBlock('Channels', channelList.split('\n')));
  },

  // 3. Create Text Channel
  createtext: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .createtext <channel-name>');
    await message.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      reason: 'Manage Server Command'
    });
    await message.channel.send(`Created text channel: ${name}`);
  },

  // 4. Create Voice Channel
  createvoice: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .createvoice <channel-name>');
    await message.guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      reason: 'Manage Server Command'
    });
    await message.channel.send(`Created voice channel: ${name}`);
  },

  // 5. Delete Channel
  deletechannel: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .deletechannel <channel-name>');
    const channel = message.guild.channels.cache.find(c => c.name === name);
    if (!channel) return message.channel.send(`Channel ${name} not found`);
    await channel.delete('Manage Server Command');
    await message.channel.send(`Deleted channel: ${name}`);
  },

  // 6. Create Role
  createrole: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .createrole <role-name>');
    await message.guild.roles.create({ name, reason: 'Manage Server Command' });
    await message.channel.send(`Created role: ${name}`);
  },

  // 7. Delete Role
  deleterole: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .deleterole <role-name>');
    const role = message.guild.roles.cache.find(r => r.name === name);
    if (!role) return message.channel.send(`Role ${name} not found`);
    await role.delete('Manage Server Command');
    await message.channel.send(`Deleted role: ${name}`);
  },

  // 8. Assign Role
  assignrole: async (message, args) => {
    const member = message.mentions.members.first();
    const roleName = args.slice(1).join(' ');
    if (!member || !roleName) return message.channel.send('Usage: .assignrole @user <role-name>');
    const role = message.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return message.channel.send(`Role ${roleName} not found`);
    await member.roles.add(role);
    await message.channel.send(`Assigned role ${roleName} to ${member.user.tag}`);
  },

  // 9. Remove Role
  removerole: async (message, args) => {
    const member = message.mentions.members.first();
    const roleName = args.slice(1).join(' ');
    if (!member || !roleName) return message.channel.send('Usage: .removerole @user <role-name>');
    const role = message.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return message.channel.send(`Role ${roleName} not found`);
    await member.roles.remove(role);
    await message.channel.send(`Removed role ${roleName} from ${member.user.tag}`);
  },

  // 10. Kick User
  kick: async (message, args) => {
    const member = message.mentions.members.first();
    if (!member) return message.channel.send('Usage: .kick @user');
    await member.kick('Manage Server Command');
    await message.channel.send(`Kicked ${member.user.tag}`);
  },

  // 11. Ban User
  ban: async (message, args) => {
    const member = message.mentions.members.first();
    if (!member) return message.channel.send('Usage: .ban @user');
    await member.ban({ reason: 'Manage Server Command' });
    await message.channel.send(`Banned ${member.user.tag}`);
  },

  // 12. Unban User
  unban: async (message, args) => {
    const id = args[0];
    if (!id) return message.channel.send('Usage: .unban <user-id>');
    await message.guild.members.unban(id);
    await message.channel.send(`Unbanned user ID: ${id}`);
  },

  // 13. Mute Member
  mute: async (message, args) => {
    const member = message.mentions.members.first();
    if (!member) return message.channel.send('Usage: .mute @user');
    let muteRole = message.guild.roles.cache.find(r => r.name === 'Muted');
    if (!muteRole) {
      muteRole = await message.guild.roles.create({ name: 'Muted', reason: 'Manage Server Command' });
      message.guild.channels.cache.forEach(c => c.permissionOverwrites.create(muteRole, { SendMessages: false, AddReactions: false }));
    }
    await member.roles.add(muteRole);
    await message.channel.send(`Muted ${member.user.tag}`);
  },

  // 14. Unmute Member
  unmute: async (message, args) => {
    const member = message.mentions.members.first();
    if (!member) return message.channel.send('Usage: .unmute @user');
    const muteRole = message.guild.roles.cache.find(r => r.name === 'Muted');
    if (!muteRole) return message.channel.send('Muted role not found');
    await member.roles.remove(muteRole);
    await message.channel.send(`Unmuted ${member.user.tag}`);
  },

  // 15. Lock Channel
  lockchannel: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    await message.channel.send(`Locked ${channel.name}`);
  },

  // 16. Unlock Channel
  unlockchannel: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    await channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });
    await message.channel.send(`Unlocked ${channel.name}`);
  },

  // 17. Purge Messages
  purge: async (message, args) => {
    const amount = parseInt(args[0], 10);
    if (isNaN(amount) || amount <= 0) return message.channel.send('Usage: .purge <number>');
    await message.channel.bulkDelete(amount, true);
    await message.channel.send(`Deleted ${amount} messages`).then(msg => setTimeout(() => msg.delete(), 5000));
  },

  // 18. Slowmode
  slowmode: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    const seconds = parseInt(args[0], 10);
    if (isNaN(seconds) || seconds < 0) return message.channel.send('Usage: .slowmode <seconds>');
    await channel.setRateLimitPerUser(seconds, 'Manage Server Command');
    await message.channel.send(`Set slowmode of ${channel.name} to ${seconds} seconds`);
  },

  // 19. Server Icon
  servericon: async (message) => {
    const guild = message.guild;
    if (!guild.iconURL()) return message.channel.send('Server has no icon');
    await message.channel.send({ content: `Server Icon:`, files: [guild.iconURL({ dynamic: true, size: 1024 })] });
  },

  // 20. Server Banner
  serverbanner: async (message) => {
    const guild = message.guild;
    if (!guild.bannerURL()) return message.channel.send('Server has no banner');
    await message.channel.send({ content: `Server Banner:`, files: [guild.bannerURL({ size: 1024 })] });
  },

  // 21. Server Boosts
  boosts: async (message) => {
    const guild = message.guild;
    await message.channel.send(`Server has ${guild.premiumSubscriptionCount} boosts`);
  },

  // 22. Add Emoji
  addemoji: async (message, args) => {
    const [name, url] = args;
    if (!name || !url) return message.channel.send('Usage: .addemoji <name> <url>');
    await message.guild.emojis.create({ name, attachment: url });
    await message.channel.send(`Added emoji: ${name}`);
  },

  // 23. Remove Emoji
  removeemoji: async (message, args) => {
    const name = args[0];
    if (!name) return message.channel.send('Usage: .removeemoji <name>');
    const emoji = message.guild.emojis.cache.find(e => e.name === name);
    if (!emoji) return message.channel.send(`Emoji ${name} not found`);
    await emoji.delete();
    await message.channel.send(`Deleted emoji: ${name}`);
  },

  // 24. List Roles
  listroles: async (message) => {
    const roleList = message.guild.roles.cache.map(r => r.name).join('\n');
    await message.channel.send(formatBlock('Roles', roleList.split('\n')));
  },

  // 25. Rename Channel
  renamechannel: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    const name = args.slice(0).join(' ');
    if (!name) return message.channel.send('Usage: .renamechannel <new-name>');
    await channel.setName(name, 'Manage Server Command');
    await message.channel.send(`Renamed channel to: ${name}`);
  }
};

module.exports = manageServerCommands;
// ===============================
// MANAGE SERVER COMMANDS (26-50)
// ===============================

const manageServerCommandsPart2 = {
  // 26. Change Server Name
  setservername: async (message, args) => {
    const newName = args.join(' ');
    if (!newName) return message.channel.send('Usage: .setservername <new-name>');
    await message.guild.setName(newName, 'Manage Server Command');
    await message.channel.send(`Server name changed to: ${newName}`);
  },

  // 27. Set AFK Channel
  setafk: async (message, args) => {
    const channel = message.mentions.channels.first();
    if (!channel) return message.channel.send('Usage: .setafk #channel');
    await message.guild.setAFKChannel(channel, 'Manage Server Command');
    await message.channel.send(`AFK channel set to: ${channel.name}`);
  },

  // 28. Set AFK Timeout
  setafktimeout: async (message, args) => {
    const timeout = parseInt(args[0]);
    if (isNaN(timeout)) return message.channel.send('Usage: .setafktimeout <seconds>');
    await message.guild.setAFKTimeout(timeout, 'Manage Server Command');
    await message.channel.send(`AFK timeout set to ${timeout} seconds`);
  },

  // 29. Set Verification Level
  setverification: async (message, args) => {
    const level = args[0]?.toLowerCase();
    const levels = ['none', 'low', 'medium', 'high', 'very_high'];
    if (!levels.includes(level)) return message.channel.send(`Usage: .setverification <${levels.join('|')}>`);
    await message.guild.setVerificationLevel(level, 'Manage Server Command');
    await message.channel.send(`Verification level set to: ${level}`);
  },

  // 30. Set Explicit Content Filter
  setfilter: async (message, args) => {
    const level = args[0]?.toLowerCase();
    const levels = ['disabled', 'members_without_roles', 'all_members'];
    if (!levels.includes(level)) return message.channel.send(`Usage: .setfilter <${levels.join('|')}>`);
    await message.guild.setExplicitContentFilter(level, 'Manage Server Command');
    await message.channel.send(`Explicit Content Filter set to: ${level}`);
  },

  // 31. Create Category
  createcategory: async (message, args) => {
    const name = args.join(' ');
    if (!name) return message.channel.send('Usage: .createcategory <name>');
    await message.guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      reason: 'Manage Server Command'
    });
    await message.channel.send(`Category created: ${name}`);
  },

  // 32. Delete Category
  deletecategory: async (message, args) => {
    const name = args.join(' ');
    if (!name) return message.channel.send('Usage: .deletecategory <name>');
    const cat = message.guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildCategory);
    if (!cat) return message.channel.send(`Category not found: ${name}`);
    await cat.delete('Manage Server Command');
    await message.channel.send(`Deleted category: ${name}`);
  },

  // 33. Lock Category
  lockcategory: async (message, args) => {
    const cat = message.guild.channels.cache.find(c => c.name === args.join(' ') && c.type === ChannelType.GuildCategory);
    if (!cat) return message.channel.send('Category not found');
    for (const ch of cat.children.values()) {
      await ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    }
    await message.channel.send(`Locked category: ${cat.name}`);
  },

  // 34. Unlock Category
  unlockcategory: async (message, args) => {
    const cat = message.guild.channels.cache.find(c => c.name === args.join(' ') && c.type === ChannelType.GuildCategory);
    if (!cat) return message.channel.send('Category not found');
    for (const ch of cat.children.values()) {
      await ch.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });
    }
    await message.channel.send(`Unlocked category: ${cat.name}`);
  },

  // 35. Add Channel to Category
  addto: async (message, args) => {
    const channel = message.mentions.channels.first();
    const catName = args.slice(1).join(' ');
    const cat = message.guild.channels.cache.find(c => c.name === catName && c.type === ChannelType.GuildCategory);
    if (!channel || !cat) return message.channel.send('Usage: .addto #channel <category-name>');
    await channel.setParent(cat);
    await message.channel.send(`Moved ${channel.name} to category ${cat.name}`);
  },

  // 36. Remove Channel from Category
  removefrom: async (message, args) => {
    const channel = message.mentions.channels.first();
    if (!channel) return message.channel.send('Usage: .removefrom #channel');
    await channel.setParent(null);
    await message.channel.send(`Removed ${channel.name} from its category`);
  },

  // 37. Set Channel Topic
  settopic: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    const topic = args.join(' ');
    if (!topic) return message.channel.send('Usage: .settopic <topic>');
    await channel.setTopic(topic);
    await message.channel.send(`Channel topic set: ${topic}`);
  },

  // 38. Rename Role
  renamerole: async (message, args) => {
    const role = message.guild.roles.cache.find(r => r.name === args[0]);
    const newName = args.slice(1).join(' ');
    if (!role || !newName) return message.channel.send('Usage: .renamerole <old-name> <new-name>');
    await role.setName(newName);
    await message.channel.send(`Role renamed to: ${newName}`);
  },

  // 39. Set Role Color
  setrolecolor: async (message, args) => {
    const role = message.guild.roles.cache.find(r => r.name === args[0]);
    const color = args[1];
    if (!role || !color) return message.channel.send('Usage: .setrolecolor <role> <hex-color>');
    await role.setColor(color);
    await message.channel.send(`Role color updated: ${role.name}`);
  },

  // 40. Toggle Role Hoist
  hoistrole: async (message, args) => {
    const role = message.guild.roles.cache.find(r => r.name === args[0]);
    if (!role) return message.channel.send('Usage: .hoistrole <role>');
    await role.setHoist(!role.hoist);
    await message.channel.send(`Role ${role.name} hoist toggled to ${role.hoist}`);
  },

  // 41. Toggle Role Mentionable
  mentionablerole: async (message, args) => {
    const role = message.guild.roles.cache.find(r => r.name === args[0]);
    if (!role) return message.channel.send('Usage: .mentionablerole <role>');
    await role.setMentionable(!role.mentionable);
    await message.channel.send(`Role ${role.name} mentionable toggled to ${role.mentionable}`);
  },

  // 42. Set Role Permissions
  setroleperms: async (message, args) => {
    const role = message.guild.roles.cache.find(r => r.name === args[0]);
    const perms = args.slice(1);
    if (!role || !perms.length) return message.channel.send('Usage: .setroleperms <role> <perm1> <perm2> ...');
    await role.setPermissions(perms);
    await message.channel.send(`Role permissions updated: ${role.name}`);
  },

  // 43. Enable NSFW Channel
  nsfw: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    await channel.setNSFW(true);
    await message.channel.send(`${channel.name} marked as NSFW`);
  },

  // 44. Disable NSFW Channel
  safe: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    await channel.setNSFW(false);
    await message.channel.send(`${channel.name} unmarked as NSFW`);
  },

  // 45. Set Channel Rate Limit
  setslowmode: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    const seconds = parseInt(args[0]);
    if (isNaN(seconds)) return message.channel.send('Usage: .setslowmode <seconds>');
    await channel.setRateLimitPerUser(seconds);
    await message.channel.send(`Channel slowmode set to ${seconds} seconds`);
  },

  // 46. View Audit Logs
  auditlogs: async (message, args) => {
    const logs = await message.guild.fetchAuditLogs({ limit: 10 });
    const entries = logs.entries.map(e => `${e.action} by ${e.executor.tag}`).join('\n');
    await message.channel.send(formatBlock('Audit Logs', entries.split('\n')));
  },

  // 47. Toggle Channel NSFW
  toggleNSFW: async (message, args) => {
    const channel = message.mentions.channels.first() || message.channel;
    await channel.setNSFW(!channel.nsfw);
    await message.channel.send(`NSFW toggled for ${channel.name}: ${channel.nsfw}`);
  },

  // 48. Show Banned Users
  bannedusers: async (message) => {
    const bans = await message.guild.bans.fetch();
    const list = bans.map(b => `${b.user.tag} (${b.user.id})`).join('\n') || 'No banned users';
    await message.channel.send(formatBlock('Banned Users', list.split('\n')));
  },

  // 49. Toggle Server AFK Timeout
  afktimeout: async (message, args) => {
    const timeout = parseInt(args[0]);
    if (isNaN(timeout)) return message.channel.send('Usage: .afktimeout <seconds>');
    await message.guild.setAFKTimeout(timeout);
    await message.channel.send(`AFK timeout updated to ${timeout} seconds`);
  },

  // 50. Delete All Bot-Created Channels (Clean-up)
  cleanup: async (message) => {
    const botChannels = message.guild.channels.cache.filter(c => c.name.startsWith('render') || c.name.startsWith('bot-status'));
    for (const ch of botChannels.values()) {
      await ch.delete('Bot cleanup command');
    }
    const role = message.guild.roles.cache.find(r => r.name === 'System Services Manager');
    if (role) await role.delete('Bot cleanup command');
    await message.channel.send('Deleted all bot-created channels and role');
  }
};

module.exports = manageServerCommandsPart2;
// ===============================
// BOT COMMANDS (1-50)
// ===============================

const botCommands = {
  // 1. Show Bot Status
  status: async (message) => {
    const uptimeMs = Date.now() - (message.client.readyAt ? message.client.readyAt.getTime() : Date.now());
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
    await message.channel.send({ embeds: [makeEmbed({
      title: 'Bot Status',
      description: 'Current status of the bot.',
      fields: [
        { name: 'Username', value: message.client.user.tag, inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Guilds', value: `${message.client.guilds.cache.size}`, inline: true },
        { name: 'Channels', value: `${message.client.channels.cache.size}`, inline: true },
        { name: 'Latency', value: `${message.client.ws.ping}ms`, inline: true },
      ],
      color: 0x00BFFF,
      footer: 'System Services'
    })]});
  },

  // 2. Set Bot Presence
  setpresence: async (message, args) => {
    const activity = args.join(' ') || 'System Services';
    await message.client.user.setPresence({ activities: [{ name: activity, type: 0 }], status: 'online' });
    await message.channel.send(`Bot presence updated: ${activity}`);
  },

  // 3. Restart Bot
  restart: async (message) => {
    await message.channel.send('Bot is restarting...');
    process.exit(0); // relies on host to restart bot
  },

  // 4. Shutdown Bot
  shutdown: async (message) => {
    await message.channel.send('Bot is shutting down...');
    process.exit(0);
  },

  // 5. Set Bot Nickname
  setnickname: async (message, args) => {
    const nick = args.join(' ');
    if (!nick) return message.channel.send('Usage: .setnickname <nickname>');
    await message.guild.members.me.setNickname(nick);
    await message.channel.send(`Bot nickname set to: ${nick}`);
  },

  // 6. Enable Logging
  enablelogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].loggingEnabled = true;
    persistGuildSettings();
    await message.channel.send('Bot logging enabled for this guild.');
  },

  // 7. Disable Logging
  disablelogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].loggingEnabled = false;
    persistGuildSettings();
    await message.channel.send('Bot logging disabled for this guild.');
  },

  // 8. Set Logging Channel
  setlogchannel: async (message, args) => {
    const channel = message.mentions.channels.first();
    if (!channel) return message.channel.send('Usage: .setlogchannel #channel');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].logChannelId = channel.id;
    persistGuildSettings();
    await message.channel.send(`Logging channel set to: ${channel.name}`);
  },

  // 9. Toggle Command Notifications
  togglecmdnotif: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].commandNotifications = !guildSettings[message.guild.id].commandNotifications;
    persistGuildSettings();
    await message.channel.send(`Command notifications toggled: ${guildSettings[message.guild.id].commandNotifications}`);
  },

  // 10. Set Default Prefix
  setprefix: async (message, args) => {
    const prefix = args[0];
    if (!prefix) return message.channel.send('Usage: .setprefix <prefix>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].prefix = prefix;
    persistGuildSettings();
    await message.channel.send(`Command prefix updated: ${prefix}`);
  },

  // 11. Set Rich Embed Color
  setembedcolor: async (message, args) => {
    const color = args[0];
    if (!color) return message.channel.send('Usage: .setembedcolor <hex>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].embedColor = color;
    persistGuildSettings();
    await message.channel.send(`Embed color updated to: ${color}`);
  },

  // 12. Show Guild Settings
  guildsettings: async (message) => {
    const settings = guildSettings[message.guild.id] || {};
    await message.channel.send(formatBlock('Guild Settings', Object.entries(settings).map(([k, v]) => `${k}: ${v}`)));
  },

  // 13. Reset Guild Settings
  resetsettings: async (message) => {
    guildSettings[message.guild.id] = {};
    persistGuildSettings();
    await message.channel.send('Guild settings reset.');
  },

  // 14. Enable Auto Setup on Join
  enableautosetup: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].autoSetup = true;
    persistGuildSettings();
    await message.channel.send('Auto setup enabled for future guild joins.');
  },

  // 15. Disable Auto Setup
  disableautosetup: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].autoSetup = false;
    persistGuildSettings();
    await message.channel.send('Auto setup disabled for future guild joins.');
  },

  // 16. Toggle Presence Rotation
  togglepresence: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].presenceRotation = !guildSettings[message.guild.id].presenceRotation;
    persistGuildSettings();
    await message.channel.send(`Presence rotation toggled: ${guildSettings[message.guild.id].presenceRotation}`);
  },

  // 17. Set Presence Messages
  setpresencemsgs: async (message, args) => {
    if (!args.length) return message.channel.send('Usage: .setpresencemsgs <message1|message2|...>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].presenceMessages = args.join(' ').split('|');
    persistGuildSettings();
    await message.channel.send(`Presence messages updated: ${guildSettings[message.guild.id].presenceMessages.join(', ')}`);
  },

  // 18. Enable Webhook Forwarding
  enablewebhook: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].webhookForwarding = true;
    persistGuildSettings();
    await message.channel.send('Render webhook forwarding enabled.');
  },

  // 19. Disable Webhook Forwarding
  disablewebhook: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].webhookForwarding = false;
    persistGuildSettings();
    await message.channel.send('Render webhook forwarding disabled.');
  },

  // 20. Show Active Webhooks
  webhooks: async (message) => {
    const hooks = await message.guild.fetchWebhooks();
    const list = hooks.map(h => `${h.name} (${h.id})`).join('\n') || 'No webhooks';
    await message.channel.send(formatBlock('Webhooks', list.split('\n')));
  },

  // 21. Enable Debug Mode
  enabledebug: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].debugMode = true;
    persistGuildSettings();
    await message.channel.send('Debug mode enabled.');
  },

  // 22. Disable Debug Mode
  disabledebug: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].debugMode = false;
    persistGuildSettings();
    await message.channel.send('Debug mode disabled.');
  },

  // 23. Send Test Log
  testlog: async (message) => {
    const channelId = guildSettings[message.guild.id]?.logChannelId;
    const ch = message.guild.channels.cache.get(channelId);
    if (!ch) return message.channel.send('No log channel configured.');
    await ch.send(formatBlock('Test Log', ['This is a test log from System Services bot.']));
    await message.channel.send('Test log sent.');
  },

  // 24. Enable Bot Alerts
  enablealerts: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].botAlerts = true;
    persistGuildSettings();
    await message.channel.send('Bot alerts enabled.');
  },

  // 25. Disable Bot Alerts
  disablealerts: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].botAlerts = false;
    persistGuildSettings();
    await message.channel.send('Bot alerts disabled.');
  },

  // 26. Toggle Reaction Logging
  togglereactionlogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].reactionLogs = !guildSettings[message.guild.id].reactionLogs;
    persistGuildSettings();
    await message.channel.send(`Reaction logging toggled: ${guildSettings[message.guild.id].reactionLogs}`);
  },

  // 27. Set Bot Activity Type
  setactivitytype: async (message, args) => {
    const type = args[0]?.toUpperCase();
    if (!['PLAYING','WATCHING','LISTENING','COMPETING'].includes(type)) return message.channel.send('Usage: .setactivitytype <PLAYING|WATCHING|LISTENING|COMPETING>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].activityType = type;
    persistGuildSettings();
    await message.channel.send(`Bot activity type set to: ${type}`);
  },

  // 28. Enable Mention Pings
  enablepings: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].mentionPings = true;
    persistGuildSettings();
    await message.channel.send('Mention pings enabled.');
  },

  // 29. Disable Mention Pings
  disablepings: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].mentionPings = false;
    persistGuildSettings();
    await message.channel.send('Mention pings disabled.');
  },

  // 30. Toggle Embed Logging
  toggleembeds: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].embedLogging = !guildSettings[message.guild.id].embedLogging;
    persistGuildSettings();
    await message.channel.send(`Embed logging toggled: ${guildSettings[message.guild.id].embedLogging}`);
  },

  // 31. Show Bot Commands List
  botcommands: async (message) => {
    await message.channel.send(formatBlock('Bot Commands', Object.keys(botCommands).join('\n').split('\n')));
  },

  // 32. Enable Console Logs
  enableconsolelogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].consoleLogs = true;
    persistGuildSettings();
    await message.channel.send('Console logs enabled.');
  },

  // 33. Disable Console Logs
  disableconsolelogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].consoleLogs = false;
    persistGuildSettings();
    await message.channel.send('Console logs disabled.');
  },

  // 34. Set Command Cooldown
  setcooldown: async (message, args) => {
    const sec = parseInt(args[0]);
    if (isNaN(sec)) return message.channel.send('Usage: .setcooldown <seconds>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].commandCooldown = sec;
    persistGuildSettings();
    await message.channel.send(`Command cooldown set to ${sec} seconds`);
  },

  // 35. Toggle Fun Commands
  togglefun: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].funCommands = !guildSettings[message.guild.id].funCommands;
    persistGuildSettings();
    await message.channel.send(`Fun commands toggled: ${guildSettings[message.guild.id].funCommands}`);
  },

  // 36. Toggle Misc Commands
  togglemisc: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].miscCommands = !guildSettings[message.guild.id].miscCommands;
    persistGuildSettings();
    await message.channel.send(`Misc commands toggled: ${guildSettings[message.guild.id].miscCommands}`);
  },

  // 37. Enable Server Logging
  enableserverlogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].serverLogs = true;
    persistGuildSettings();
    await message.channel.send('Server logging enabled.');
  },

  // 38. Disable Server Logging
  disableserverlogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].serverLogs = false;
    persistGuildSettings();
    await message.channel.send('Server logging disabled.');
  },

  // 39. Toggle Debug Logs
  toggledblogs: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].debugLogs = !guildSettings[message.guild.id].debugLogs;
    persistGuildSettings();
    await message.channel.send(`Debug logs toggled: ${guildSettings[message.guild.id].debugLogs}`);
  },

  // 40. Reset Bot Settings
  resetbot: async (message) => {
    guildSettings[message.guild.id] = {};
    persistGuildSettings();
    await message.channel.send('Bot settings reset for this guild.');
  },

  // 41. Enable Rich Presence
  enablerp: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].richPresence = true;
    persistGuildSettings();
    await message.channel.send('Rich presence enabled.');
  },

  // 42. Disable Rich Presence
  disablerp: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].richPresence = false;
    persistGuildSettings();
    await message.channel.send('Rich presence disabled.');
  },

  // 43. Enable Bot Alerts Channel
  setalertschannel: async (message, args) => {
    const ch = message.mentions.channels.first();
    if (!ch) return message.channel.send('Usage: .setalertschannel #channel');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].alertsChannelId = ch.id;
    persistGuildSettings();
    await message.channel.send(`Bot alerts channel set to ${ch.name}`);
  },

  // 44. Send Test Alert
  testalert: async (message) => {
    const chId = guildSettings[message.guild.id]?.alertsChannelId;
    const ch = message.guild.channels.cache.get(chId);
    if (!ch) return message.channel.send('No alerts channel set.');
    await ch.send('Test alert from System Services bot.');
    await message.channel.send('Test alert sent.');
  },

  // 45. Enable DM Alerts
  enabledmalerts: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].dmAlerts = true;
    persistGuildSettings();
    await message.channel.send('DM alerts enabled.');
  },

  // 46. Disable DM Alerts
  disabledmalerts: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].dmAlerts = false;
    persistGuildSettings();
    await message.channel.send('DM alerts disabled.');
  },

  // 47. Set Bot Log Level
  setloglevel: async (message, args) => {
    const level = args[0]?.toLowerCase();
    if (!['info','warn','error','debug'].includes(level)) return message.channel.send('Usage: .setloglevel <info|warn|error|debug>');
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].logLevel = level;
    persistGuildSettings();
    await message.channel.send(`Bot log level set to: ${level}`);
  },

  // 48. Enable Auto Presence Updates
  enableautopresence: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].autoPresence = true;
    persistGuildSettings();
    await message.channel.send('Auto presence updates enabled.');
  },

  // 49. Disable Auto Presence Updates
  disableautopresence: async (message) => {
    guildSettings[message.guild.id] = guildSettings[message.guild.id] || {};
    guildSettings[message.guild.id].autoPresence = false;
    persistGuildSettings();
    await message.channel.send('Auto presence updates disabled.');
  },

  // 50. Show Bot Info
  botinfo: async (message) => {
    const version = '1.0.0';
    const uptimeMs = Date.now() - (message.client.readyAt ? message.client.readyAt.getTime() : Date.now());
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptime = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m ${uptimeSec % 60}s`;
    await message.channel.send({ embeds: [makeEmbed({
      title: 'Bot Info',
      description: 'Detailed bot information',
      fields: [
        { name: 'Version', value: version, inline: true },
        { name: 'Guilds', value: `${message.client.guilds.cache.size}`, inline: true },
        { name: 'Channels', value: `${message.client.channels.cache.size}`, inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Ping', value: `${message.client.ws.ping}ms`, inline: true }
      ],
      color: 0xFF4500,
      footer: 'System Services'
    })]});
  }
};

module.exports = botCommands;

// ===============================
// Helper Functions
// ===============================

function formatBlock(title, lines) {
  return `**${title}**\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

function makeEmbed({ title, description, fields = [], color = 0x00BFFF, footer = '' }) {
  return {
    title,
    description,
    color,
    fields,
    footer: { text: footer },
    timestamp: new Date()
  };
}

function persistGuildSettings() {
  // Placeholder: Save guildSettings object to JSON or database
}
