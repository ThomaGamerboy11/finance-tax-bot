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

// Extrair saldo de qualquer mensagem (template humano OU embed do bot)
function extractBalanceFromMessage(msg) {
  // 1) template humano
  const content = msg.content || "";
  const match = content.match(BALANCE_REGEX);
  if (match) {
    const parsed = parsePtNumber(match[1]);
    if (parsed !== null) return parsed;
  }

  // 2) embed do bot "Saldo Atual"
  if (msg.author?.id === client.user.id && msg.embeds?.length > 0) {
    const e = msg.embeds[0];
    const title = (e.title || "").toLowerCase();
    if (title.includes("saldo atual")) {
      const parsed2 = extractBalanceFromEmbed(e);
      if (parsed2 !== null) return parsed2;
    }
  }

  return null;
}

async function fetchRecentBalancePoints(channel, maxPages = 30, pageSize = 100) {
  let beforeId = null;
  const points = [];

  for (let page = 0; page < maxPages; page++) {
    const batch = await channel.messages.fetch({ limit: pageSize, before: beforeId });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      const value = extractBalanceFromMessage(msg);
      if (value !== null) {
        points.push({ ts: msg.createdTimestamp, value });
      }
      beforeId = msg.id;
    }
  }

  // Ordenar por tempo (antigo -> recente)
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Aprende taxas reais a partir do histórico e escolhe a mais provável para o saldo atual
async function estimateTaxRate(channel, currentBalance) {
  const points = await fetchRecentBalancePoints(channel);

  // Construir dataset de “taxas observadas”
  const observations = [];
  for (let i = 0; i < points.length - 1; i++) {
    const prev = points[i];
    const next = points[i + 1];

    const hours = (next.ts - prev.ts) / (1000 * 60 * 60);

    // Queremos pares com distância “tipo diária”
    if (hours < 6 || hours > 30) continue;

    // Só interessa quando desce (imposto). Se subir, ignorar.
    if (next.value >= prev.value) continue;

    const rate = (prev.value - next.value) / prev.value;

    // Filtrar ruído/valores absurdos
    if (rate <= 0 || rate > 0.10) continue;

    observations.push({ balance: prev.value, rate });
  }

  if (observations.length === 0) {
    // fallback (não há dados) — mete 2% por defeito
    return 0.02;
  }

  // Pegar nas taxas mais próximas do saldo atual
  observations.sort((a, b) => Math.abs(a.balance - currentBalance) - Math.abs(b.balance - currentBalance));
  const k = observations.slice(0, Math.min(7, observations.length));
  const rates = k.map(o => o.rate);

  // Mediana é estável (evita outliers)
  const r = median(rates);

  // Segurança extra
  if (!r || !Number.isFinite(r)) return 0.02;
  return Math.max(0.001, Math.min(r, 0.10));
}

async function findLatestBalance(channel) {
  // procura do mais recente para trás (como tinhas)
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
      const value = extractBalanceFromMessage(msg);
      if (value !== null) {
        if (!anyCandidate) anyCandidate = { value };
        if (now - msg.createdTimestamp <= last24hMs) {
          if (!last24hCandidate) last24hCandidate = { value };
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

    // ✅ taxa variável (aprendida)
    const taxRate = await estimateTaxRate(channel, previous);

    const deducted = previous * taxRate;
    const newBalance = previous - deducted;

    console.log("Saldo base:", previous, "| taxa:", (taxRate * 100).toFixed(4) + "%", "| novo:", newBalance);

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
    try { await message.delete(); } catch {}
    await postDailyTaxEmbed("manual");
  }
});

client.once("ready", () => {
  console.log(`🟢 Online como ${client.user.tag}`);

  cron.schedule(
    "0 8 * * *",
    () => postDailyTaxEmbed("auto"),
    { timezone: "Europe/Lisbon" }
  );

  console.log("⏰ Scheduler ativo: todos os dias às 08:00 (Lisboa)");
});

client.login(TOKEN);
