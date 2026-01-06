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

/**
 * ✅ ESCALÕES (edita aqui)
 * Regras: o bot escolhe o PRIMEIRO escalão cujo "min" seja <= saldo.
 * Ordena por min desc (do maior para o menor).
 *
 * Pelos teus exemplos:
 * - Há uma taxa ~2.5% (2.4999%)
 * - Há uma taxa ~1.064482%
 *
 * ⚠️ Ajusta os limites (min) conforme a regra real do teu sistema.
 */
const TAX_BRACKETS = [
  // Exemplo: saldos a partir de X usam ~1.064482% (AJUSTA o X real!)
  { min: 1350000, rate: 0.010644821471031877 }, // ~1.064482%

  // Exemplo: abaixo disso usam 2.5%
  { min: 0, rate: 0.025 }, // 2.5%
];

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

function getTaxRate(balance) {
  // escolhe o primeiro bracket cujo min <= balance
  for (const b of TAX_BRACKETS) {
    if (balance >= b.min) return b.rate;
  }
  // fallback (não devia acontecer porque tens {min:0})
  return 0.025;
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

    const previous = found.value;

    // ✅ taxa variável por escalão
    const taxRate = getTaxRate(previous);

    const deducted = previous * taxRate;
    const newBalance = previous - deducted;

    console.log(
      "Saldo base:", previous,
      "Fonte:", found.source,
      "Taxa:", (taxRate * 100).toFixed(4) + "%"
    );

    const embed = new EmbedBuilder()
      .setColor(0x661515)
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
    try {
      await message.delete();
    } catch {
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


