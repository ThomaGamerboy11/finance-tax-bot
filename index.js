const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");

const TOKEN = process.env.DISCORD_TOKEN;

// canal 💰┋registo-finanças
const FINANCE_CHANNEL_ID = "1296915981830062100";

if (!TOKEN) {
  console.error("Falta a variável de ambiente DISCORD_TOKEN");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Template humano: - *Valor Corrente na Conta:* X.XXX.XXX€
const BALANCE_REGEX = /Valor Corrente na Conta:\*\s*([\d.\s]+(?:,\d{1,2})?)\s*€/i;

// Embed do bot: "## 1.331.239€" dentro da descrição
const EMBED_BALANCE_REGEX = /##\s*([\d.\s]+)\s*€/i;

function parsePtNumber(str) {
  const clean = str.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

async function findLatestBalance(channel) {
  const now = Date.now();
  const last24hMs = 24 * 60 * 60 * 1000;

  let last24hCandidate = null;
  let anyCandidate = null;

  let beforeId = null;
  const MAX_PAGES = 30;
  const PAGE_SIZE = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: PAGE_SIZE, before: beforeId });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      // 1) TENTAR LER DO TEMPLATE NORMAL
      const content = msg.content || "";
      const match = content.match(BALANCE_REGEX);
      if (match) {
        const parsed = parsePtNumber(match[1]);
        if (parsed !== null) {
          if (!anyCandidate) anyCandidate = { value: parsed };
          if (now - msg.createdTimestamp <= last24hMs) {
            if (!last24hCandidate) last24hCandidate = { value: parsed };
          }
        }
      }

      // 2) SE NÃO HÁ TEMPLATE, LER DO ÚLTIMO EMBED DO BOT
      if (msg.author?.id === client.user.id && msg.embeds?.length > 0) {
        const e = msg.embeds[0];
        const title = e.title || "";
        const desc = e.description || "";

        if (title.includes("Saldo Atual") && desc) {
          const m2 = desc.match(EMBED_BALANCE_REGEX);
          if (m2) {
            const parsed2 = parsePtNumber(m2[1]);
            if (parsed2 !== null) {
              if (!anyCandidate) anyCandidate = { value: parsed2 };
              if (now - msg.createdTimestamp <= last24hMs) {
                if (!last24hCandidate) last24hCandidate = { value: parsed2 };
              }
            }
          }
        }
      }

      beforeId = msg.id;
    }

    if (last24hCandidate) break;
  }

  return last24hCandidate || anyCandidate;
}


async function postDailyTaxEmbed(trigger = "auto") {
  try {
    const channel = await client.channels.fetch(FINANCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) return;

    const found = await findLatestBalance(channel);
    if (!found) {
      await channel.send("Não encontrei nenhum **Valor Corrente na Conta** no histórico.");
      return;
    }

    const previous = found.value;
    const taxRate = 0.02;
    const deducted = previous * taxRate;
    const newBalance = previous - deducted;

    const embed = new EmbedBuilder()
     .setColor(0xe74c3c) // vermelho
     .setTitle("💲 Saldo Atual:")
     .setDescription(` ### ${formatEuro(newBalance)}`);

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

  } catch (err) {
    console.error("Erro no postDailyTaxEmbed:", err?.message || err);
  }
}

/* 🔧 COMANDO MANUAL !saldo */
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== FINANCE_CHANNEL_ID) return;

  if (message.content.toLowerCase() === "!saldo") {
    await postDailyTaxEmbed("manual");
  }
});

client.once("ready", () => {
  console.log(`🟢 Online como ${client.user.tag}`);

  cron.schedule(
    "0 8 * * *",
    () => {
      postDailyTaxEmbed("auto");
    },
    { timezone: "Europe/Lisbon" }
  );

  console.log("⏰ Scheduler ativo: todos os dias às 08:00 (Lisboa)");
});

client.login(TOKEN);
