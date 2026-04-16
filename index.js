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

// ================= STATE =================
const users = {};
const transactions = {};
const processedPayments = new Set(); // 🔥 idempotência webhook
const actionLock = {}; // 🔥 anti double click

// ================= SAFE USER =================
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
            event_id: user.event_id || uuidv4(),
            action_source: "website",
            user_data: {
              client_ip_address: user.ip || "",
              client_user_agent: user.ua || "",
              fbc: user.fbc || "",
              fbp: user.fbp || ""
            },
            custom_data: {
              currency: "BRL",
              value: Number(user.value || 0)
            }
          }
        ]
      }
    );
  } catch (err) {
    console.log("META ERROR:", err.response?.data || err.message);
  }
}

// ================= START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;

    let payload = {};
    try {
      const param = match[1]?.trim();
      if (param) {
        payload = JSON.parse(Buffer.from(param, "base64").toString());
      }
    } catch {}

    users[chat_id] = {
      fbc: payload.fbc || "",
      fbp: payload.fbp || "",
      ip: payload.ip || "",
      ua: payload.ua || "",
      event_id: uuidv4(),
      value: 0
    };

    await sendToMeta("PageView", users[chat_id]);

    await bot.sendMessage(chat_id, "Bem-vindo!", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⭐ 7 DIAS - R$7.42", callback_data: "plan_week" }],
          [{ text: "🔥 VIP - R$15.42", callback_data: "plan_vip" }],
          [{ text: "💎 FULL - R$23.42", callback_data: "plan_full" }]
        ]
      }
    });

  } catch (err) {
    console.log("START ERROR:", err);
  }
});

// ================= CALLBACK =================
bot.on("callback_query", async (query) => {
  try {
    if (!query?.message?.chat?.id) return;

    const chat_id = query.message.chat.id;
    const data = query.data;

    const user = getUser(chat_id);

    // 🔥 remove loading do Telegram
    await bot.answerCallbackQuery(query.id).catch(() => {});

    // ================= LOCK =================
    const lockKey = `${chat_id}:${data}`;
    if (actionLock[lockKey]) return;
    actionLock[lockKey] = true;

    setTimeout(() => {
      delete actionLock[lockKey];
    }, 5000);

    // ================= PLANOS =================
    if (data.startsWith("plan_")) {

      if (data === "plan_week") user.value = 7.42;
      if (data === "plan_vip") user.value = 15.42;
      if (data === "plan_full") user.value = 23.42;

      await sendToMeta("InitiateCheckout", user);

      return bot.sendMessage(chat_id, `
🚫 ORDER BUMP

Adicionar por R$4,99?
`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ ADICIONAR", callback_data: "bump_yes" },
            { text: "❌ NÃO QUERO", callback_data: "bump_no" }
          ]]
        }
      });
    }

    // ================= BUMP =================
    if (data === "bump_yes") {

      user.value = Number(user.value || 0) + 4.99;

      return goToPayment(chat_id, user);
    }

    if (data === "bump_no") {
      return goToPayment(chat_id, user);
    }

    // ================= UPSELL =================
    if (data === "upsell_buy") {

      try {
        const response = await axios.post(PIX_API, {
          amount: 10
        });

        const tx_id = response.data.id;

        transactions[tx_id] = { chat_id, user, upsell: true };

        return bot.sendMessage(chat_id, `
🔥 UPSELL

💳 R$10

${response.data.pix_code}
`);
      } catch (err) {
        console.log("PIX ERROR:", err.response?.data || err.message);
        return bot.sendMessage(chat_id, "Erro ao gerar PIX.");
      }
    }

  } catch (err) {
    console.log("CALLBACK GLOBAL ERROR:", err);
  }
});

// ================= PAYMENT =================
async function goToPayment(chat_id, user) {
  try {
    const response = await axios.post(PIX_API, {
      amount: Number(user.value || 0)
    });

    const tx_id = response.data.id;

    transactions[tx_id] = { chat_id, user };

    await bot.sendMessage(chat_id, `
💳 PIX GERADO

Valor: R$ ${user.value || 0}

${response.data.pix_code}
`);

  } catch (err) {
    console.log("PAYMENT ERROR:", err.response?.data || err.message);
    await bot.sendMessage(chat_id, "Erro ao gerar pagamento.");
  }
}

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  try {
    const { id, status } = req.body;

    if (processedPayments.has(id)) {
      return res.sendStatus(200);
    }

    if (status === "paid" && transactions[id]) {

      processedPayments.add(id);

      const { chat_id, user, upsell } = transactions[id];

      user.value = Number(user.value || 0);

      // ================= COMPRA =================
      if (!upsell) {

        await sendToMeta("Purchase", user);

        await bot.sendMessage(chat_id, `
✅ PAGAMENTO CONFIRMADO
Acesso liberado 🔥
`);

        await bot.sendMessage(chat_id, `
🔒 TAXA DE SEGURANÇA R$10
`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "PAGAR R$10", callback_data: "upsell_buy" }]
            ]
          }
        });

      } else {
        await bot.sendMessage(chat_id, `
🚀 ACESSO TOTAL LIBERADO
`);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.log("WEBHOOK ERROR:", err);
    res.sendStatus(200);
  }
});

// ================= SAFETY NET =================
process.on("unhandledRejection", (err) => {
  console.log("UNHANDLED:", err);
});

process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT:", err);
});

// ================= SERVER =================
app.listen(3000, () => console.log("BOT PRO 100% BLINDADO ONLINE"));
