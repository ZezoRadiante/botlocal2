// ================= IMPORTS =================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PIX_API = process.env.PIX_API;
const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_TOKEN = process.env.META_TOKEN;

// ================= INIT =================
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.use(bodyParser.json());

const users = {};
const transactions = {};

// ================= META =================
async function sendToMeta(event_name, user) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`,
      {
        data: [
          {
            event_name,
            event_time: Math.floor(Date.now() / 1000),
            event_id: user.event_id,
            action_source: "website",
            user_data: {
              client_ip_address: user.ip,
              client_user_agent: user.ua,
              fbc: user.fbc,
              fbp: user.fbp
            },
            custom_data: {
              currency: "BRL",
              value: user.value || 0
            }
          }
        ]
      }
    );
  } catch (err) {
    console.log("Erro Meta:", err.response?.data || err.message);
  }
}

// ================= START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chat_id = msg.chat.id;

  let payload = {};

  try {
    const param = match[1]?.trim();
    if (param) {
      payload = JSON.parse(Buffer.from(param, "base64").toString());
    }
  } catch (e) {
    console.log("Erro payload:", e.message);
  }

  const event_id = uuidv4();

  users[chat_id] = {
    fbc: payload.fbc || "",
    fbp: payload.fbp || "",
    ip: payload.ip || "",
    ua: payload.ua || "",
    event_id,
    value: 23.42
  };

  await sendToMeta("PageView", users[chat_id]);

  await bot.sendMessage(chat_id, `
⬇️ VEJA COMO É O VIP POR DENTRO DIVIDIDO EM TÓPICOS PARA VOCÊ 🔴

😍 OnlyFans 🔴 Vídeos raros
😈 Privacy ✨ Lives¹⁸
🌈 Novinhas¹⁸ ❤️ Close Friends
👀 Inc3st0 😢 Em Público
💕 Fetiches 🌈 Amador
🍼 Milf’s 🔞 PROIBIDINHOS¹⁸
😳 F4M1L1A S4c4na 💋 Ocultos¹⁸
😡 Faveladas 🔥 KAM1LINHA
🙈 Sexo na faculdade¹⁸
🌈 Un1vers1t4r1as V4z4d4s¹⁸

📁 +207.629 mídias no nosso VIP
🔴 +31.735 mídias OCULTAS
😈 + 6 Grupos secretos

⚠️ sua gozada garantida ou seu dinheiro de volta! ⏱️

🚀 Acesso imediato!
⏰ PROMOÇÃO ENCERRA EM 6 MINUTOS!
💥 (9 vagas restantes) 💥

⚠️ Esta conversa pode sumir em alguns minutos! ⏱️
`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔥 ENTRAR AGORA", callback_data: "start" }]
      ]
    }
  });
});

// ================= FLOW =================
bot.on("callback_query", async (query) => {
  const chat_id = query.message.chat.id;
  const user = users[chat_id];

  if (!user) return;

  if (query.data === "start") {
    await sendToMeta("InitiateCheckout", user);

    await bot.sendMessage(chat_id, `
🚫 LIVES BANIDAS 🔥

😈 Não perca o acesso das Lives mais exclusivas do Brasil! 🇧🇷

📁 SEPARADAS POR PASTAS
💎 CONTEÚDOS ATUALIZADOS

🔥 APENAS HOJE → R$4,99
`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ ADICIONAR", callback_data: "bump_yes" },
          { text: "❌ NÃO QUERO", callback_data: "bump_no" }
        ]]
      }
    });
  }

  if (query.data === "bump_yes") {
    user.value = 23.42 + 4.99;
  }

  if (query.data === "bump_no") {
    user.value = 23.42;
  }

  if (query.data === "bump_yes" || query.data === "bump_no") {
    await bot.sendMessage(chat_id, `
🔒 Tarifa de Segurança

💳 R$10 (reembolsável)
`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "PAGAR", callback_data: "pay" }]
        ]
      }
    });
  }

  if (query.data === "pay") {
    try {
      const final_price = user.value + 10;

      const response = await axios.post(PIX_API, {
        amount: final_price
      });

      const tx_id = response.data.id;

      transactions[tx_id] = { chat_id, user };

      await bot.sendMessage(chat_id, `
💳 PAGAMENTO PIX

Valor: R$ ${final_price}

${response.data.pix_code}
`);
    } catch (err) {
      console.log("Erro PIX:", err.message);
      await bot.sendMessage(chat_id, "Erro ao gerar PIX.");
    }
  }
});

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  const { id, status } = req.body;

  if (status === "paid" && transactions[id]) {
    const { chat_id, user } = transactions[id];

    await sendToMeta("Purchase", {
      ...user,
      value: user.value + 10
    });

    bot.sendMessage(chat_id, "✅ ACESSO LIBERADO");
  }

  res.sendStatus(200);
});

// ================= SERVER =================
app.listen(3000, () => {
  console.log("BOT PRO ONLINE");
});
