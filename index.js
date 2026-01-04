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

// Para ler valores com € do embed (qualquer formato)
const ANY_EURO_NUMBER_REGEX = /([\d.\s]+)\s*€/i;

function parsePtNumber(str) {
  const clean = str.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

// Formato desejado: x.xxx.xxx€
function formatEuro(num) {
  return (
    new Intl.NumberFormat("pt-PT", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(Math.round(num)) + "€"
  );
}

function extractBalanceFromEmbed(embed) {
  const parts = [];

  if (embed?.title) parts.push(String(embed.title));
  if (embed?.description) parts.push(String(embed.description));

  // discord.js v14: embed pode ter fields
  if (Array.isArray(embed?.fields)) {
    for (const f of embed.fields) {
      if (f?.name) parts.push(String(f.name));
      if (f?.value) parts.push(String(f.value));
    }
  }

  const joined = parts.join("\n");
  const m = joined.match(ANY_EURO_NUMBER_REGEX);
  if (!m) return null;

  return parsePtNumber(m[1]);
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
      // 1) LER DO TEMPLATE HUMANO
      const content = msg.content || "";
      const match = content.match(BALANCE_REGEX);
      if (match) {
        const parsed = parsePtNumber(match[1]);
        if (parsed !== null) {
          if (!anyCandidate) anyCandidate = { value: parsed, source: "template" };
          if (now - msg.createdTimestamp <= last24hMs) {
            if (!last24hCandidate) last24hCandidate = { value: parsed, source: "template" };
          }
        }
      }

      // 2) SE NÃO HÁ TEMPLATE, LER DO ÚLTIMO EMBED DO BOT
      if (msg.author?.id === client.user.id && msg.embeds?.length > 0) {
        const e = msg.embeds[0];
        const title = (e.title || "").toLowerCase();

        // só aceitar embeds do bot que sejam o "Saldo Atual"
        if (title.includes("saldo atual")) {
          const parsed2 = extractBalanceFromEmbed(e);
          if (parsed2 !== null) {
            if (!anyCandidate) anyCandidate = { value: parsed2, source: "embed" };
            if (now - msg.createdTimestamp <= last24hMs) {
              if (!last24hCandidate) last24hCandidate = { value: parsed2, source: "embed" };
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

    console.log("Saldo base:", found.value, "Fonte:", found.source);

    const previous = found.value;
    const taxRate = 0.02;
    const deducted = previous * taxRate;
    const newBalance = previous - deducted;

    const embed = new EmbedBuilder()
      .setColor(0x661515) // vermelho escuro (podes trocar se quiseres)
      .setTitle("💲 Saldo Atual:")
      .setDescription(`### ${formatEuro(newBalance)}`);

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
    // apagar a mensagem do comando
    try {
      await message.delete();
    } catch (e) {
      console.warn("Não consegui apagar a mensagem !saldo (permissões?)");
    }

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

