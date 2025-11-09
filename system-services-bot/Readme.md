# System Services Bot

A Discord bot that automatically sets up a private system monitoring category when added to a server, and integrates with Render webhooks for live deployment and error updates.

## Features

- Auto creates:
  - Webhook: `System Services`
  - Category: `System Services Status`
  - Channels: `render-console-logs`, `render-errors`, `render-failed`, `render-status`, `bot-status`
  - Role: `System Services Manager` (full permissions, assigned to the bot adder)
- Private category visibility
- Logs Render webhook events directly into Discord channels

---

## 🧩 Setup Instructions

### 1. Clone this repository
```bash
git clone https://github.com/YOUR_USERNAME/system-services-bot.git
cd system-services-bot
