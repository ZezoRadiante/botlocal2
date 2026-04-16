const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);

const SYNCPAY_BASE_URL = (process.env.SYNCPAY_BASE_URL || '').replace(/\/+$/, '');
const SYNCPAY_CLIENT_ID = process.env.SYNCPAY_CLIENT_ID;
const SYNCPAY_CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET;

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_TOKEN = process.env.META_TOKEN;

// ================= VALIDATION =================
if (!TOKEN) throw new Error('BOT_TOKEN não configurado');
if (!SYNCPAY_BASE_URL) throw new Error('SYNCPAY_BASE_URL não configurado');
if (!SYNCPAY_CLIENT_ID) throw new Error('SYNCPAY_CLIENT_ID não configurado');
if (!SYNCPAY_CLIENT_SECRET) throw new Error('SYNCPAY_CLIENT_SECRET não configurado');

// ================= INIT =================
const bot = new TelegramBot(TOKEN, { polling: true });

const app = express();
app.use(bodyParser.json());

// ================= STATE =================
const users = {};
const transactions = {};
const processedPayments = new Set();
const actionLock = {};

// ================= SYNCPAY AUTH CACHE =================
let syncpayToken = null;
let syncpayTokenExpiresAt = 0;

// ================= HELPERS =================
function getUser(chat_id) {
  if (!users[chat_id]) {
    users[chat_id] = {
      fbc: '',
      fbp: '',
      ip: '',
      ua: '',
      event_id: uuidv4(),
      value: 0
    };
  }
  return users[chat_id];
}

function lockAction(key, ttlMs = 5000) {
  if (actionLock[key]) return false;
  actionLock[key] = true;
  setTimeout(() => delete actionLock[key], ttlMs);
  return true;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatBRL(value) {
  return roundMoney(value).toFixed(2);
}

// ================= META =================
async function sendToMeta(event_name, user) {
  if (!META_PIXEL_ID || !META_TOKEN) return;

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`,
      {
        data: [
          {
            event_name,
            event_time: Math.floor(Date.now() / 1000),
            event_id: user.event_id || uuidv4(),
            action_source: 'website',
            user_data: {
              client_ip_address: user.ip || '',
              client_user_agent: user.ua || '',
              fbc: user.fbc || '',
              fbp: user.fbp || ''
            },
            custom_data: {
              currency: 'BRL',
              value: roundMoney(user.value || 0)
            }
          }
        ]
      },
      { timeout: 15000 }
    );
  } catch (err) {
    console.log('META ERROR:', err.response?.data || err.message);
  }
}

// ================= SYNCPAY =================
async function getSyncPayAccessToken() {
  const now = Date.now();

  if (syncpayToken && now < syncpayTokenExpiresAt - 60_000) {
    return syncpayToken;
  }

  const url = `${SYNCPAY_BASE_URL}/api/partner/v1/auth-token`;

  const response = await axios.post(
    url,
    {
      client_id: SYNCPAY_CLIENT_ID,
      client_secret: SYNCPAY_CLIENT_SECRET
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  const accessToken = response.data?.access_token;
  const expiresIn = Number(response.data?.expires_in || 3600);

  if (!accessToken) {
    throw new Error(`Auth SyncPay inválido: ${JSON.stringify(response.data)}`);
  }

  syncpayToken = accessToken;
  syncpayTokenExpiresAt = now + expiresIn * 1000;

  return syncpayToken;
}

async function syncpayRequest(method, path, data) {
  const accessToken = await getSyncPayAccessToken();

  const response = await axios({
    method,
    url: `${SYNCPAY_BASE_URL}${path}`,
    data,
    timeout: 25000,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data;
}

function extractTransactionId(data) {
  return (
    data?.id ||
    data?.data?.id ||
    data?.reference_id ||
    data?.transaction_id ||
    null
  );
}

function extractPixCode(data) {
  return (
    data?.pix_code ||
    data?.data?.pix_code ||
    data?.qr_code ||
    data?.data?.qr_code ||
    data?.pix?.payload ||
    data?.data?.pix?.payload ||
    null
  );
}

async function createSyncPayCashIn(amount) {
  const payload = { amount: roundMoney(amount) };

  // endpoint inferido da árvore atual da documentação "Pix - CashIn"
  const data = await syncpayRequest('POST', '/api/partner/v1/cash-in', payload);

  const txId = extractTransactionId(data);
  const pixCode = extractPixCode(data);

  if (!txId || !pixCode) {
    throw new Error(`Resposta cash-in inesperada da SyncPay: ${JSON.stringify(data)}`);
  }

  return { txId, pixCode, raw: data };
}

// ================= START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;

    let payload = {};
    try {
      const param = match[1]?.trim();
      if (param) {
        payload = JSON.parse(Buffer.from(param, 'base64').toString());
      }
    } catch {}

    users[chat_id] = {
      fbc: payload.fbc || '',
      fbp: payload.fbp || '',
      ip: payload.ip || '',
      ua: payload.ua || '',
      event_id: uuidv4(),
      value: 0
    };

    await sendToMeta('PageView', users[chat_id]);

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

⚠️ sua gozada garantida ou seu dinheiro de volta!

🚀 Acesso imediato!
⏰ PROMOÇÃO ENCERRA EM 6 MINUTOS!
💥 (9 vagas restantes)
`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⭐ 1 SEMANA 30% OFF - R$7.42', callback_data: 'plan_week' }],
          [{ text: '🔥 VIP VITALÍCIO - R$15.42', callback_data: 'plan_vip' }],
          [{ text: '🌸 VITALÍCIO + PASTAS - R$23.42', callback_data: 'plan_full' }]
        ]
      }
    });
  } catch (err) {
    console.log('START ERROR:', err.response?.data || err.message || err);
  }
});

// ================= FLOW =================
bot.on('callback_query', async (query) => {
  try {
    if (!query?.message?.chat?.id) return;

    const chat_id = query.message.chat.id;
    const data = query.data;
    const user = getUser(chat_id);

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const lockKey = `${chat_id}:${data}`;
    if (!lockAction(lockKey)) return;

    if (data.startsWith('plan_')) {
      user.event_id = uuidv4();

      if (data === 'plan_week') user.value = 7.42;
      if (data === 'plan_vip') user.value = 15.42;
      if (data === 'plan_full') user.value = 23.42;

      await sendToMeta('InitiateCheckout', user);

      return await bot.sendMessage(chat_id, `
🚫 LIVES BANIDAS 🔥

😈 Não perca o acesso das Lives mais exclusivas do Brasil!

📁 SEPARADAS POR PASTAS
💎 CONTEÚDOS ATUALIZADOS DIARIAMENTE

🔥 ADICIONE POR APENAS R$4,99
`, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ ADICIONAR', callback_data: 'bump_yes' },
            { text: '❌ NÃO QUERO', callback_data: 'bump_no' }
          ]]
        }
      });
    }

    if (data === 'bump_yes') {
      user.value = roundMoney(Number(user.value || 0) + 4.99);
      return await goToPayment(chat_id, user, false);
    }

    if (data === 'bump_no') {
      return await goToPayment(chat_id, user, false);
    }

    if (data === 'upsell_buy') {
      return await goToPayment(chat_id, user, true, 10);
    }
  } catch (err) {
    console.log('CALLBACK ERROR:', err.response?.data || err.message || err);
    try {
      if (query?.message?.chat?.id) {
        await bot.sendMessage(query.message.chat.id, '❌ Erro ao processar sua ação.');
      }
    } catch {}
  }
});

// ================= PAGAMENTO =================
async function goToPayment(chat_id, user, isUpsell = false, forcedAmount = null) {
  try {
    const amount = roundMoney(forcedAmount ?? user.value);

    if (!amount || amount <= 0) {
      throw new Error(`Valor inválido para cobrança: ${amount}`);
    }

    const { txId, pixCode, raw } = await createSyncPayCashIn(amount);

    transactions[txId] = {
      chat_id,
      user: { ...user },
      upsell: isUpsell
    };

    console.log('SYNCPAY CASHIN OK:', raw);

    await bot.sendMessage(chat_id, `
💳 PAGAMENTO PIX

Valor: R$ ${formatBRL(amount)}

${pixCode}
`);
  } catch (err) {
    console.log('PAYMENT ERROR FULL:', {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });

    await bot.sendMessage(chat_id, '❌ Erro ao gerar pagamento.');
  }
}

// ================= WEBHOOK =================
app.post('/webhook', async (req, res) => {
  try {
    const eventHeader = req.headers['event'];
    const body = req.body || {};
    const data = body.data || body;

    const txId = data?.id || body?.id;
    const status = data?.status || body?.status;

    if (!txId) return res.sendStatus(200);
    if (processedPayments.has(txId)) return res.sendStatus(200);

    // SyncPay usa cashin.create e cashin.update nos webhooks
    if (eventHeader === 'cashin.update' && status === 'completed' && transactions[txId]) {
      processedPayments.add(txId);

      const { chat_id, user, upsell } = transactions[txId];

      if (!upsell) {
        await sendToMeta('Purchase', user);

        await bot.sendMessage(chat_id, `
✅ PAGAMENTO CONFIRMADO!

Seu acesso está sendo liberado...
`);

        await bot.sendMessage(chat_id, `
🔒 Tarifa de Segurança – Verificação Obrigatória

Nós prezamos pela segurança dos membros.

💳 R$10 (100% reembolsável)

⚠️ Caso não pague, o acesso pode ser bloqueado.
`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🟢 PAGAR TARIFA R$10', callback_data: 'upsell_buy' }]
            ]
          }
        });
      } else {
        await bot.sendMessage(chat_id, `
🚀 ACESSO TOTAL LIBERADO!

Aproveite todo o conteúdo 🔥
`);
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log('WEBHOOK ERROR:', err.response?.data || err.message || err);
    return res.sendStatus(200);
  }
});

// ================= SAFETY =================
process.on('unhandledRejection', (err) => {
  console.log('UNHANDLED REJECTION:', err);
});

process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT EXCEPTION:', err);
});

// ================= SERVER =================
app.listen(PORT, () => {
  console.log(`BOT PRO ONLINE NA PORTA ${PORT}`);
});
