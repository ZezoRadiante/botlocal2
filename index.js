const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const SYNCPAY_URL = (process.env.SYNCPAY_BASE_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SYNCPAY_CLIENT_ID;
const CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET;

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_TOKEN = process.env.META_TOKEN;

// ================= MEDIA =================
const VIDEO_START = 'BAACAgEAAxkBAANjaeE1lWS7RCCUF3G0cehARZeHIxoAArkGAAIqEglHTEGxhQwHcS87BA';
const VIDEO_BUMP = 'BAACAgEAAxkBAANlaeE1r7jftHF1Z1ZkDpTLWFFY1_cAAroGAAIqEglHsnlZ68ElDLU7BA';

// Futuras mídias do downsell
const DOWNSELL_MEDIA = {
  enabled: false,
  type: 'video', // 'video' | 'photo' | 'document'
  fileId: '',
  caption: `
⚠️ ÚLTIMA CHANCE

Se você não quer seguir com a oferta principal, temos uma condição especial por tempo limitado.
`
};

// ================= BUMP SCHEDULE =================
// 12 bumps automáticos
const ORDER_BUMP_SCHEDULES = [
  { key: 'bump_1', delayMs: 10 * 60 * 1000 },
  { key: 'bump_2', delayMs: 20 * 60 * 1000 },
  { key: 'bump_3', delayMs: 45 * 60 * 1000 },
  { key: 'bump_4', delayMs: 60 * 60 * 1000 },
  { key: 'bump_5', delayMs: 2 * 60 * 60 * 1000 },
  { key: 'bump_6', delayMs: 4 * 60 * 60 * 1000 },
  { key: 'bump_7', delayMs: 6 * 60 * 60 * 1000 },
  { key: 'bump_8', delayMs: 8 * 60 * 60 * 1000 },
  { key: 'bump_9', delayMs: 12 * 60 * 60 * 1000 },
  { key: 'bump_10', delayMs: 18 * 60 * 60 * 1000 },
  { key: 'bump_11', delayMs: 24 * 60 * 60 * 1000 },
  { key: 'bump_12', delayMs: 36 * 60 * 60 * 1000 }
];

// ================= VALIDATION =================
if (!TOKEN) throw new Error('BOT_TOKEN não configurado');
if (!BASE_URL) throw new Error('RENDER_EXTERNAL_URL não configurado');
if (!SYNCPAY_URL) throw new Error('SYNCPAY_BASE_URL não configurado');
if (!CLIENT_ID) throw new Error('SYNCPAY_CLIENT_ID não configurado');
if (!CLIENT_SECRET) throw new Error('SYNCPAY_CLIENT_SECRET não configurado');

// ================= INIT =================
const TELEGRAM_PATH = '/telegram';
const PAYMENT_PATH = '/webhook';
const TELEGRAM_WEBHOOK_URL = `${BASE_URL}${TELEGRAM_PATH}`;

const bot = new TelegramBot(TOKEN, { webHook: true });
const app = express();
app.use(bodyParser.json());

// ================= MEMORY STATE =================
const users = {};
const transactions = {};
const processedPayments = new Set();
const actionLock = {};
const processedMetaEvents = new Set();
const scheduledBumpTimeouts = {};

let accessToken = null;
let accessTokenExpiresAt = 0;

// ================= HELPERS =================
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatBRL(value) {
  return roundMoney(value).toFixed(2);
}

function safeBase64JsonDecode(encoded) {
  try {
    const normalized = String(encoded || '').trim();
    if (!normalized) return {};
    const json = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function getUser(chat_id) {
  if (!users[chat_id]) {
    users[chat_id] = {
      chat_id,
      fbc: '',
      fbp: '',
      ip: '',
      ua: '',
      lang: '',
      screen: '',
      tz: '',
      referrer: '',
      host: '',
      path: '',
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_content: '',
      utm_term: '',
      utm_ad: '',
      campaign_id: '',
      adset_id: '',
      ad_id: '',
      redirect_event_id: '',
      event_id: uuidv4(),
      value: 0,
      plan: '',
      hasPaidMain: false,
      hasPaidUpsell: false,
      stopRemarketing: false,
      bumpHistory: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  users[chat_id].updatedAt = Date.now();
  return users[chat_id];
}

function mergeUser(chat_id, payload = {}) {
  const user = getUser(chat_id);

  users[chat_id] = {
    ...user,
    chat_id,
    fbc: payload.fbc || user.fbc || '',
    fbp: payload.fbp || user.fbp || '',
    ip: payload.ip || user.ip || '',
    ua: payload.ua || user.ua || '',
    lang: payload.lang || user.lang || '',
    screen: payload.screen || user.screen || '',
    tz: payload.tz || user.tz || '',
    referrer: payload.referrer || user.referrer || '',
    host: payload.host || user.host || '',
    path: payload.path || user.path || '',
    utm_source: payload.utm_source || user.utm_source || '',
    utm_medium: payload.utm_medium || user.utm_medium || '',
    utm_campaign: payload.utm_campaign || user.utm_campaign || '',
    utm_content: payload.utm_content || user.utm_content || '',
    utm_term: payload.utm_term || user.utm_term || '',
    utm_ad: payload.utm_ad || user.utm_ad || '',
    campaign_id: payload.campaign_id || user.campaign_id || '',
    adset_id: payload.adset_id || user.adset_id || '',
    ad_id: payload.ad_id || user.ad_id || '',
    redirect_event_id: payload.redirect_event_id || user.redirect_event_id || '',
    updatedAt: Date.now()
  };

  return users[chat_id];
}

function lockAction(key, ttlMs = 5000) {
  if (actionLock[key]) return false;
  actionLock[key] = true;
  setTimeout(() => delete actionLock[key], ttlMs);
  return true;
}

function extractTransactionId(data) {
  return (
    data?.id ||
    data?.data?.id ||
    data?.identifier ||
    data?.data?.identifier ||
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

function createTransactionRecord({ txId, chat_id, user, amount, upsell = false, downsell = false }) {
  transactions[txId] = {
    txId,
    chat_id,
    user: { ...user },
    amount: roundMoney(amount),
    upsell,
    downsell,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function markTransactionPaid(txId) {
  if (!transactions[txId]) return;
  transactions[txId].status = 'paid';
  transactions[txId].updatedAt = Date.now();
  transactions[txId].paidAt = Date.now();
}

function cancelAllScheduledBumps(chat_id) {
  const timers = scheduledBumpTimeouts[chat_id];
  if (!timers) return;

  for (const timeoutId of Object.values(timers)) {
    clearTimeout(timeoutId);
  }

  delete scheduledBumpTimeouts[chat_id];
}

function canSendScheduledBump(chat_id, bumpKey) {
  const user = users[chat_id];
  if (!user) return false;
  if (user.hasPaidMain) return false;
  if (user.hasPaidUpsell) return false;
  if (user.stopRemarketing) return false;
  if (user.bumpHistory?.[bumpKey]) return false;
  return true;
}

function getScheduledBumpCopy(index) {
  const copies = [
    `🔥 Você entrou e ainda não garantiu seu acesso.\n\nAs vagas promocionais estão acabando e o VIP pode sair do ar a qualquer momento.`,
    `⚠️ Seu acesso ainda está pendente.\n\nSe quiser entrar com desconto, essa é a melhor hora para finalizar.`,
    `🚨 Muita gente entra, olha e volta depois.\n\nQuando volta, a promoção já acabou.`,
    `⏳ Seu benefício ainda está disponível.\n\nMas não dá para garantir por muito tempo.`,
    `🔥 O conteúdo continua te esperando.\n\nSe quiser aproveitar o valor atual, finalize agora.`,
    `😈 As melhores pastas e mídias continuam bloqueadas.\n\nSó falta liberar seu acesso.`,
    `⚠️ Estamos nas últimas vagas promocionais.\n\nDepois disso, o valor pode subir.`,
    `💥 Últimas horas com essa condição.\n\nSe você quer entrar, esse é o melhor momento.`,
    `🔥 Seu acesso ainda não foi ativado.\n\nNão deixa para depois e perde a oferta.`,
    `🚨 Oferta quase encerrada.\n\nAinda dá tempo de entrar pagando menos.`,
    `⏰ O desconto segue ativo por pouco tempo.\n\nFinalize enquanto ainda está liberado.`,
    `⚠️ Último aviso.\n\nDepois dessa mensagem, não dá para garantir que o valor continue o mesmo.`
  ];

  return copies[index] || `⚠️ Sua oferta ainda está disponível por pouco tempo.`;
}

async function scheduleOrderBumps(chat_id) {
  const user = getUser(chat_id);

  cancelAllScheduledBumps(chat_id);
  scheduledBumpTimeouts[chat_id] = {};

  ORDER_BUMP_SCHEDULES.forEach((item, index) => {
    const timeoutId = setTimeout(async () => {
      try {
        if (!canSendScheduledBump(chat_id, item.key)) return;

        const currentUser = getUser(chat_id);
        currentUser.bumpHistory[item.key] = Date.now();

        await sendOptionalVideo(chat_id, VIDEO_BUMP, `AUTO BUMP VIDEO ${item.key}`);

        await bot.sendMessage(chat_id, `
${getScheduledBumpCopy(index)}

💳 Toque abaixo para gerar seu pagamento agora.
`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 GERAR PIX AGORA', callback_data: 'remarketing_pay_now' }],
              [{ text: '❌ NÃO QUERO', callback_data: 'remarketing_no' }]
            ]
          }
        });
      } catch (err) {
        console.log(`SCHEDULED BUMP ERROR ${item.key}:`, err.response?.data || err.message || err);
      }
    }, item.delayMs);

    scheduledBumpTimeouts[chat_id][item.key] = timeoutId;
  });

  user.updatedAt = Date.now();
}

// ================= META =================
async function sendToMeta(event_name, user, overrideEventId = null) {
  if (!META_PIXEL_ID || !META_TOKEN) return;

  const metaEventId = overrideEventId || user.event_id || uuidv4();
  const dedupeKey = `${event_name}:${metaEventId}`;

  if (processedMetaEvents.has(dedupeKey)) return;
  processedMetaEvents.add(dedupeKey);

  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`,
      {
        data: [
          {
            event_name,
            event_time: nowSec(),
            event_id: metaEventId,
            action_source: 'website',
            user_data: {
              client_ip_address: user.ip || '',
              client_user_agent: user.ua || '',
              fbc: user.fbc || '',
              fbp: user.fbp || ''
            },
            custom_data: {
              currency: 'BRL',
              value: roundMoney(user.value || 0),
              utm_source: user.utm_source || '',
              utm_medium: user.utm_medium || '',
              utm_campaign: user.utm_campaign || '',
              utm_content: user.utm_content || '',
              utm_term: user.utm_term || '',
              campaign_id: user.campaign_id || '',
              adset_id: user.adset_id || '',
              ad_id: user.ad_id || ''
            }
          }
        ]
      },
      { timeout: 15000 }
    );
  } catch (err) {
    processedMetaEvents.delete(dedupeKey);
    console.log('META ERROR:', err.response?.data || err.message);
  }
}

// ================= SYNCPAY =================
async function getToken() {
  const now = Date.now();

  if (accessToken && now < accessTokenExpiresAt - 60000) {
    return accessToken;
  }

  const res = await axios.post(
    `${SYNCPAY_URL}/api/partner/v1/auth-token`,
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    }
  );

  if (!res.data?.access_token) {
    throw new Error(`Auth SyncPay inválido: ${JSON.stringify(res.data)}`);
  }

  accessToken = res.data.access_token;
  accessTokenExpiresAt = now + (Number(res.data?.expires_in || 3600) * 1000);

  return accessToken;
}

async function createSyncPayCashIn(amount) {
  const token = await getToken();

  const response = await axios.post(
    `${SYNCPAY_URL}/api/partner/v1/cash-in`,
    { amount: roundMoney(amount) },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 25000
    }
  );

  const data = response.data;
  const txId = extractTransactionId(data);
  const pixCode = extractPixCode(data);

  if (!txId || !pixCode) {
    throw new Error(`Resposta cash-in inesperada da SyncPay: ${JSON.stringify(data)}`);
  }

  return { txId, pixCode, raw: data };
}

// ================= MEDIA SENDERS =================
async function sendOptionalVideo(chat_id, fileId, logLabel) {
  if (!fileId) return;

  try {
    await bot.sendVideo(chat_id, fileId);
  } catch (err) {
    console.log(`${logLabel} ERROR:`, err.response?.data || err.message || err);
  }
}

async function sendDownsellMedia(chat_id) {
  if (!DOWNSELL_MEDIA.enabled || !DOWNSELL_MEDIA.fileId) return;

  try {
    if (DOWNSELL_MEDIA.type === 'video') {
      await bot.sendVideo(chat_id, DOWNSELL_MEDIA.fileId, {
        caption: DOWNSELL_MEDIA.caption || ''
      });
      return;
    }

    if (DOWNSELL_MEDIA.type === 'photo') {
      await bot.sendPhoto(chat_id, DOWNSELL_MEDIA.fileId, {
        caption: DOWNSELL_MEDIA.caption || ''
      });
      return;
    }

    if (DOWNSELL_MEDIA.type === 'document') {
      await bot.sendDocument(chat_id, DOWNSELL_MEDIA.fileId, {
        caption: DOWNSELL_MEDIA.caption || ''
      });
      return;
    }
  } catch (err) {
    console.log('DOWNSELL MEDIA ERROR:', err.response?.data || err.message || err);
  }
}

// ================= FLOW MESSAGES =================
async function sendPlanMessage(chat_id) {
  await sendOptionalVideo(chat_id, VIDEO_START, 'START VIDEO');

  return bot.sendMessage(chat_id, `
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
}

async function sendOrderBumpMessage(chat_id) {
  await sendOptionalVideo(chat_id, VIDEO_BUMP, 'BUMP VIDEO');

  return bot.sendMessage(chat_id, `
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

async function sendUpsellMessage(chat_id) {
  return bot.sendMessage(chat_id, `
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
}

async function sendDownsellMessage(chat_id) {
  await sendDownsellMedia(chat_id);

  return bot.sendMessage(chat_id, `
⚠️ OFERTA ESPECIAL

Ainda dá tempo de garantir uma condição diferente antes de sair.
`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💥 QUERO VER A OFERTA', callback_data: 'downsell_view' }],
        [{ text: '❌ SAIR', callback_data: 'downsell_exit' }]
      ]
    }
  });
}

// ================= PAYMENT =================
async function goToPayment(chat_id, user, options = {}) {
  const {
    isUpsell = false,
    isDownsell = false,
    forcedAmount = null
  } = options;

  try {
    const amount = roundMoney(forcedAmount ?? user.value);

    if (!amount || amount <= 0) {
      throw new Error(`Valor inválido para cobrança: ${amount}`);
    }

    const { txId, pixCode, raw } = await createSyncPayCashIn(amount);

    createTransactionRecord({
      txId,
      chat_id,
      user,
      amount,
      upsell: isUpsell,
      downsell: isDownsell
    });

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

// ================= TELEGRAM START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;
    const param = match?.[1]?.trim() || '';
    const payload = safeBase64JsonDecode(param);

    const user = mergeUser(chat_id, payload);
    user.chat_id = chat_id;
    user.event_id = uuidv4();
    user.value = 0;
    user.plan = '';
    user.hasPaidMain = false;
    user.hasPaidUpsell = false;
    user.stopRemarketing = false;
    user.bumpHistory = {};

    await sendToMeta('PageView', user, user.redirect_event_id || user.event_id);
    await sendPlanMessage(chat_id);
    await scheduleOrderBumps(chat_id);
  } catch (err) {
    console.log('START ERROR:', err.response?.data || err.message || err);
    try {
      await bot.sendMessage(msg.chat.id, '❌ Erro ao iniciar.');
    } catch {}
  }
});

// ================= TELEGRAM CALLBACK =================
bot.on('callback_query', async (query) => {
  try {
    if (!query?.message?.chat?.id) return;

    const chat_id = query.message.chat.id;
    const data = query.data;
    const user = getUser(chat_id);

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const lockKey = `${chat_id}:${data}`;
    if (!lockAction(lockKey)) return;

    if (data === 'plan_week') {
      user.value = 7.42;
      user.plan = 'week';
      user.event_id = uuidv4();
      await sendToMeta('InitiateCheckout', user);
      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'plan_vip') {
      user.value = 15.42;
      user.plan = 'vip';
      user.event_id = uuidv4();
      await sendToMeta('InitiateCheckout', user);
      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'plan_full') {
      user.value = 23.42;
      user.plan = 'full';
      user.event_id = uuidv4();
      await sendToMeta('InitiateCheckout', user);
      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'bump_yes') {
      user.value = roundMoney(Number(user.value || 0) + 4.99);
      return await goToPayment(chat_id, user, { isUpsell: false });
    }

    if (data === 'bump_no') {
      return await goToPayment(chat_id, user, { isUpsell: false });
    }

    if (data === 'upsell_buy') {
      const upsellUser = {
        ...user,
        value: 10,
        event_id: uuidv4()
      };

      return await goToPayment(chat_id, upsellUser, {
        isUpsell: true,
        forcedAmount: 10
      });
    }

    if (data === 'remarketing_pay_now') {
      if (!user.plan) {
        user.value = 15.42;
        user.plan = 'vip';
      }

      user.event_id = uuidv4();
      await sendToMeta('InitiateCheckout', user);
      return await goToPayment(chat_id, user, { isUpsell: false });
    }

    if (data === 'remarketing_no') {
      user.stopRemarketing = true;
      cancelAllScheduledBumps(chat_id);
      return await bot.sendMessage(chat_id, 'Tudo bem.');
    }

    if (data === 'downsell_view') {
      return await bot.sendMessage(chat_id, '✅ Estrutura de downsell pronta para você personalizar depois.');
    }

    if (data === 'downsell_exit') {
      return await bot.sendMessage(chat_id, 'Tudo bem.');
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

// ================= ROUTE TELEGRAM =================
app.post(TELEGRAM_PATH, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.log('TELEGRAM ROUTE ERROR:', err);
    res.sendStatus(200);
  }
});

// ================= ROUTE PAYMENT WEBHOOK =================
app.post(PAYMENT_PATH, async (req, res) => {
  try {
    const body = req.body || {};
    const data = body.data || body;
    const eventHeader = req.headers['event'];

    const txId =
      data?.identifier ||
      data?.id ||
      body?.identifier ||
      body?.id;

    const status =
      data?.status ||
      body?.status ||
      '';

    if (!txId) return res.sendStatus(200);

    if (processedPayments.has(txId)) {
      return res.sendStatus(200);
    }

    const tx = transactions[txId];
    if (!tx) {
      console.log('WEBHOOK TX NOT FOUND:', { txId, eventHeader, status, body });
      return res.sendStatus(200);
    }

    const paid =
      status === 'completed' ||
      status === 'paid' ||
      status === 'approved' ||
      body?.paid === true;

    if (!paid) {
      console.log('WEBHOOK NOT PAID YET:', { txId, eventHeader, status });
      return res.sendStatus(200);
    }

    processedPayments.add(txId);
    markTransactionPaid(txId);

    const { chat_id, user, upsell } = tx;
    const liveUser = getUser(chat_id);

    if (!upsell) {
      liveUser.hasPaidMain = true;
      liveUser.stopRemarketing = true;
      cancelAllScheduledBumps(chat_id);

      const purchaseUser = {
        ...user,
        value: tx.amount,
        event_id: uuidv4()
      };

      await sendToMeta('Purchase', purchaseUser);

      await bot.sendMessage(chat_id, `
✅ PAGAMENTO CONFIRMADO!

Seu acesso está sendo liberado...
`);

      await sendUpsellMessage(chat_id);
    } else {
      liveUser.hasPaidUpsell = true;
      liveUser.stopRemarketing = true;
      cancelAllScheduledBumps(chat_id);

      await bot.sendMessage(chat_id, `
🚀 ACESSO TOTAL LIBERADO!

Aproveite todo o conteúdo 🔥
`);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log('WEBHOOK ERROR:', err.response?.data || err.message || err);
    return res.sendStatus(200);
  }
});

// ================= HEALTH =================
app.get('/', (req, res) => {
  res.status(200).send('BOT ONLINE');
});

// ================= CLEANUP =================
setInterval(() => {
  const now = Date.now();

  for (const [chat_id, user] of Object.entries(users)) {
    if (now - (user.updatedAt || user.createdAt || now) > 7 * 24 * 60 * 60 * 1000) {
      cancelAllScheduledBumps(chat_id);
      delete users[chat_id];
    }
  }

  for (const [txId, tx] of Object.entries(transactions)) {
    if (now - (tx.updatedAt || tx.createdAt || now) > 12 * 60 * 60 * 1000) {
      delete transactions[txId];
    }
  }
}, 30 * 60 * 1000);

// ================= TELEGRAM WEBHOOK SETUP =================
async function setupTelegramWebhook() {
  try {
    await bot.deleteWebHook().catch(() => {});
    await bot.setWebHook(TELEGRAM_WEBHOOK_URL);
    const info = await bot.getWebHookInfo();
    console.log('TELEGRAM WEBHOOK OK:', info);
  } catch (err) {
    console.log('TELEGRAM WEBHOOK ERROR:', err.response?.data || err.message || err);
  }
}

// ================= SAFETY =================
process.on('unhandledRejection', (err) => {
  console.log('UNHANDLED REJECTION:', err);
});

process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT EXCEPTION:', err);
});

// ================= SERVER =================
app.listen(PORT, async () => {
  console.log(`BOT ONLINE NA PORTA ${PORT}`);
  await setupTelegramWebhook();
});
