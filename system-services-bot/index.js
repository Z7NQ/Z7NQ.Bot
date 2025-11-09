const express = require("express");
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Utility for logging to Discord channel
async function sendLog(channel, title, lines) {
  if (!channel) return;
  const message = "```" + `===== ${title} =====\n` + lines.join("\n") + "\n=====`" + "```";
  await channel.send(message);
}

// When bot joins a new guild
client.on("guildCreate", async (guild) => {
  try {
    console.log(`🚀 Joined new guild: ${guild.name}`);

    const logs = [];
    logs.push(`Guild Name: ${guild.name}`);
    logs.push(`Guild ID: ${guild.id}`);

    // Create webhook
    const systemChannel = guild.systemChannel || guild.channels.cache.find(c => c.type === ChannelType.GuildText);
    if (systemChannel) {
      await systemChannel.createWebhook({
        name: "System Services",
        reason: "Auto-created by bot",
      });
      logs.push("Created webhook: System Services");
    }

    // Create private category
    const category = await guild.channels.create({
      name: "System Services Status",
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
      ],
    });
    logs.push("Created category: System Services Status");

    // Create channels
    const channelNames = [
      "render-console-logs",
      "render-errors",
      "render-failed",
      "render-status",
      "bot-status",
    ];
    for (const name of channelNames) {
      await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: category.permissionOverwrites.cache.map(o => o),
      });
      logs.push(`Created channel: ${name}`);
    }

    // Create manager role
    const managerRole = await guild.roles.create({
      name: "System Services Manager",
      color: "#000000",
      permissions: [PermissionsBitField.Flags.Administrator],
      reason: "Full access for System Services",
    });
    logs.push("Created role: System Services Manager");

    // Assign to the bot adder
    const auditLogs = await guild.fetchAuditLogs({ type: 28, limit: 1 });
    const entry = auditLogs.entries.first();
    if (entry && entry.executor) {
      const member = await guild.members.fetch(entry.executor.id);
      if (member) {
        await member.roles.add(managerRole);
        logs.push(`Assigned role to: ${member.user.tag}`);
      }
    }

    const logChannel = guild.channels.cache.find(c => c.name === "render-console-logs");
    await sendLog(logChannel, "LOGGING", logs);

    console.log("✅ Setup completed for guild:", guild.name);
  } catch (err) {
    console.error("Setup error:", err);
  }
});

// Render webhook listener
app.post("/render-webhook", async (req, res) => {
  const secret = req.headers["x-render-signature"];
  if (secret !== process.env.RENDER_WEBHOOK_SECRET) {
    return res.status(403).send("Invalid secret");
  }

  const data = req.body;
  console.log("📦 Render Webhook:", data);

  for (const guild of client.guilds.cache.values()) {
    const statusChannel = guild.channels.cache.find(c => c.name === "render-status");
    const errorChannel = guild.channels.cache.find(c => c.name === "render-errors");

    const lines = [
      `Event Type: ${data.type}`,
      `Service ID: ${data.data?.serviceId || "Unknown"}`,
      `Timestamp: ${data.timestamp}`,
    ];

    if (data.type?.includes("failed")) {
      await sendLog(errorChannel, "RENDER FAILURE", lines);
    } else {
      await sendLog(statusChannel, "RENDER STATUS", lines);
    }
  }

  res.status(200).send("OK");
});

client.once("ready", () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

app.listen(PORT, () => console.log(`🌐 Webhook listener running on port ${PORT}`));
client.login(process.env.DISCORD_TOKEN);
