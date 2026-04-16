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

// ================= HELPERS =================
function getUser(chat_id) {
  if (!users[chat_id]) {
    users[chat_id] = {
      fbc: "",
      fbp: "",
      ip: "",
      ua: "",
      event_id: uuidv4(),
      value: 0
    };
  }
  return users[chat_id];
}

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
  } catch {}

  const event_id = uuidv4();

  users[chat_id] = {
    fbc: payload.fbc || "",
    fbp: payload.fbp || "",
    ip: payload.ip || "",
    ua: payload.ua || "",
    event_id,
    value: 0
  };

  await sendToMeta("PageView", users[chat_id]);

  await bot.sendMessage(chat_id, `
⬇️ VEJA COMO É O VIP POR DENTRO 🔴

📁 +200k mídias
🔴 conteúdo atualizado
🔥 acesso imediato

⚠️ promoção por tempo limitado
`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⭐ 1 SEMANA - R$7.42", callback_data: "plan_week" }],
        [{ text: "🔥 VIP VITALÍCIO - R$15.42", callback_data: "plan_vip" }],
        [{ text: "🌸 VIP COMPLETO - R$23.42", callback_data: "plan_full" }]
      ]
    }
  });
});

// ================= FLOW =================
bot.on("callback_query", async (query) => {
  const chat_id = query.message.chat.id;
  const user = getUser(chat_id);

  // ================= PLANOS =================
  if (query.data.startsWith("plan_")) {

    if (query.data === "plan_week") user.value = 7.42;
    if (query.data === "plan_vip") user.value = 15.42;
    if (query.data === "plan_full") user.value = 23.42;

    await sendToMeta("InitiateCheckout", user);

    await bot.sendMessage(chat_id, `
🚫 ORDER BUMP

Adicione acesso extra por apenas R$4,99
`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ ADICIONAR", callback_data: "bump_yes" },
          { text: "❌ NÃO QUERO", callback_data: "bump_no" }
        ]]
      }
    });
  }

  // ================= ORDER BUMP =================
  if (query.data === "bump_yes") {
    user.value = (user.value || 0) + 4.99;
    return goToPayment(chat_id, user);
  }

  if (query.data === "bump_no") {
    return goToPayment(chat_id, user);
  }

  // ================= UPSELL =================
  if (query.data === "upsell_buy") {

    const response = await axios.post(PIX_API, {
      amount: 10
    });

    const tx_id = response.data.id;

    transactions[tx_id] = { chat_id, user, upsell: true };

    await bot.sendMessage(chat_id, `
🔥 UPSELL VIP

💳 R$10

${response.data.pix_code}
`);
  }
});

// ================= PAGAMENTO =================
async function goToPayment(chat_id, user) {

  const response = await axios.post(PIX_API, {
    amount: user.value || 0
  });

  const tx_id = response.data.id;

  transactions[tx_id] = { chat_id, user };

  await bot.sendMessage(chat_id, `
💳 PAGAMENTO PIX

Valor: R$ ${user.value || 0}

${response.data.pix_code}
`);
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  const { id, status } = req.body;

  if (status === "paid" && transactions[id]) {
    const { chat_id, user, upsell } = transactions[id];

    user.value = user.value || 0;

    // ================= COMPRA PRINCIPAL =================
    if (!upsell) {
      await sendToMeta("Purchase", user);

      await bot.sendMessage(chat_id, `
✅ PAGAMENTO CONFIRMADO!

Seu acesso está sendo liberado...
`);

      await bot.sendMessage(chat_id, `
🔒 TARIFA DE SEGURANÇA

💳 R$10 (reembolsável)

⚠️ necessário para ativar acesso
`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🟢 PAGAR R$10", callback_data: "upsell_buy" }]
          ]
        }
      });

    } else {
      // ================= UPSELL =================
      await bot.sendMessage(chat_id, `
🚀 ACESSO TOTAL LIBERADO!

Aproveite 🔥
`);
    }
  }

  res.sendStatus(200);
});

// ================= SERVER =================
app.listen(3000, () => console.log("BOT PRO ONLINE"));
