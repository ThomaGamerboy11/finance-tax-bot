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

// Apanha: - *Valor Corrente na Conta:* X.XXX.XXX€
const BALANCE_REGEX = /Valor Corrente na Conta:\*\s*([\d.\s]+(?:,\d{1,2})?)\s*€/i;

function parseEuroNumber(str) {
  const clean = str.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
}

function formatEuro(num) {
  return new Intl.NumberFormat("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num) + "€";
}

async function findLatestBalance(channel) {
  const now = Date.now();
  const last24hMs = 24 * 60 * 60 * 1000;

  let last24hCandidate = null;
  let anyCandidate = null;

  let beforeId = null;
  const MAX_PAGES = 25;
  const PAGE_SIZE = 100;

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: PAGE_SIZE, before: beforeId });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      const content = msg.content || "";
      const match = content.match(BALANCE_REGEX);
      if (match) {
        const parsed = parseEuroNumber(match[1]);
        if (parsed !== null) {
          if (!anyCandidate) anyCandidate = { value: parsed, message: msg };
          if (now - msg.createdTimestamp <= last24hMs) {
            if (!last24hCandidate) last24hCandidate = { value: parsed, message: msg };
          }
        }
      }
      beforeId = msg.id;
    }

    if (last24hCandidate) break;
  }

  return last24hCandidate || anyCandidate;
}

async function postDailyTaxEmbed() {
  try {
    const channel = await client.channels.fetch(FINANCE_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error("FINANCE_CHANNEL_ID não é um canal de texto válido.");
      return;
    }

    const found = await findLatestBalance(channel);
    if (!found) {
      await channel.send("Não encontrei nenhum **Valor Corrente na Conta** no histórico.");
      return;
    }

    const previous = found.value;
    const taxRate = 0.02;
    const deducted = previous * taxRate;
    const newBalance = previous - deducted;

    // ✅ EMBED verde + emoji + valor grande (estilo “painel”)
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71) // verde
      .setTitle("💰 Saldo Atual")
      .setDescription(`## ${formatEuro(newBalance)}`)
      .setFooter({ text: "Atualizado automaticamente às 08:00 (Lisboa)" })
      .setTimestamp(new Date());

    // ✅ Mantém também a linha em texto normal para o bot ler amanhã
    await channel.send({
      embeds: [embed],
      content: `- *Valor Corrente na Conta:* ${formatEuro(newBalance)}`,
      allowedMentions: { parse: [] },
    });

  } catch (err) {
    console.error("Erro no postDailyTaxEmbed:", err?.message || err);
  }
}

client.once("ready", () => {
  console.log(`Online como ${client.user.tag}`);

  // Todos os dias às 08:00 (Lisboa)
  cron.schedule("0 8 * * *", () => {
    postDailyTaxEmbed();
  }, {
    timezone: "Europe/Lisbon",
  });

  console.log("Scheduler ativo: todos os dias às 08:00 (Europe/Lisbon).");
});

client.login(TOKEN);
