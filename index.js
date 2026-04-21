const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

// ================= MERCADO PAGO =================
let MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const MERCADOPAGO_CLIENT_ID = process.env.MERCADOPAGO_CLIENT_ID;
const MERCADOPAGO_CLIENT_SECRET = process.env.MERCADOPAGO_CLIENT_SECRET;
const MERCADOPAGO_WEBHOOK_SECRET = process.env.MERCADOPAGO_WEBHOOK_SECRET || '';

async function refreshMercadoPagoToken() {
  if (!MERCADOPAGO_CLIENT_ID || !MERCADOPAGO_CLIENT_SECRET) return;

  try {
    const response = await axios.post('https://api.mercadopago.com/oauth/token', {
      client_id: MERCADOPAGO_CLIENT_ID,
      client_secret: MERCADOPAGO_CLIENT_SECRET,
      grant_type: 'client_credentials'
    });

    if (response.data && response.data.access_token) {
      MERCADOPAGO_ACCESS_TOKEN = response.data.access_token;
      console.log('MERCADOPAGO TOKEN REFRESHED');
    }
  } catch (err) {
    console.log('MERCADOPAGO TOKEN REFRESH ERROR:', err.response?.data || err.message);
  }
}

// ================= META =================
const META_PIXEL_ID = '1505014021315132';
const META_TOKEN = process.env.META_TOKEN;
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';

// ================= SUPABASE =================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ================= CUSTOMER DEFAULT =================
const DEFAULT_CUSTOMER_NAME = process.env.DEFAULT_CUSTOMER_NAME || 'Cliente Telegram';
const DEFAULT_CUSTOMER_EMAIL_DOMAIN = process.env.DEFAULT_CUSTOMER_EMAIL_DOMAIN || 'gmail.com';
const DEFAULT_CUSTOMER_PHONE = process.env.DEFAULT_CUSTOMER_PHONE || '11999999999';
const DEFAULT_CUSTOMER_DOCUMENT = process.env.DEFAULT_CUSTOMER_DOCUMENT || '12345678901';

// ================= MEDIA =================
const VIDEO_START = process.env.VIDEO_START || 'BAACAgEAAxkBAANjaeE1lWS7RCCUF3G0cehARZeHIxoAArkGAAIqEglHTEGxhQwHcS87BA';
const VIDEO_BUMP = process.env.VIDEO_BUMP || 'BAACAgEAAxkBAANlaeE1r7jftHF1Z1ZkDpTLWFFY1_cAAroGAAIqEglHsnlZ68ElDLU7BA';

// ================= DOWNSELL =================
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
const ORDER_BUMP_SCHEDULES = [
  { key: 'bump_1', delayMs: 10 * 60 * 1000 },
  { key: 'bump_2', delayMs: 20 * 60 * 1000 },
  { key: 'bump_3', delayMs: 45 * 60 * 1000 },
  { key: 'bump_4', delayMs: 1 * 60 * 60 * 1000 },
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
if (!MERCADOPAGO_ACCESS_TOKEN && (!MERCADOPAGO_CLIENT_ID || !MERCADOPAGO_CLIENT_SECRET)) {
  throw new Error('MERCADOPAGO_ACCESS_TOKEN ou CLIENT_ID/SECRET não configurados');
}
if (!META_TOKEN) throw new Error('META_TOKEN não configurado');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL não configurado');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurado');

// ================= INIT =================
const TELEGRAM_PATH = '/telegram';
const PAYMENT_PATH = '/webhook';
const TELEGRAM_WEBHOOK_URL = `${BASE_URL}${TELEGRAM_PATH}`;

const bot = new TelegramBot(TOKEN, { webHook: true });
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-signature', 'x-request-id']
}));

app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  }
}));

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ================= MEMORY STATE =================
const processedPayments = new Set();
const processedMetaEvents = new Set();
const actionLock = {};

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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function lockAction(key, ttlMs = 5000) {
  if (actionLock[key]) return false;
  actionLock[key] = true;
  setTimeout(() => delete actionLock[key], ttlMs);
  return true;
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex');
}

function generateShortStartToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function buildFallbackCustomer(chat_id) {
  return {
    name: DEFAULT_CUSTOMER_NAME,
    email: `user_${chat_id}@${DEFAULT_CUSTOMER_EMAIL_DOMAIN}`,
    phone_number: onlyDigits(DEFAULT_CUSTOMER_PHONE) || '11999999999',
    document: onlyDigits(DEFAULT_CUSTOMER_DOCUMENT) || '12345678901'
  };
}

function buildUserRecord(chat_id, payload = {}) {
  const fallbackCustomer = buildFallbackCustomer(chat_id);

  return {
    chat_id,
    fbc: payload.fbc || '',
    fbp: payload.fbp || '',
    ip: payload.ip || '',
    ua: payload.ua || '',
    lang: payload.lang || '',
    screen: payload.screen || '',
    tz: payload.tz || '',
    referrer: payload.referrer || '',
    host: payload.host || '',
    path: payload.path || '',
    utm_source: payload.utm_source || '',
    utm_medium: payload.utm_medium || '',
    utm_campaign: payload.utm_campaign || '',
    utm_content: payload.utm_content || '',
    utm_term: payload.utm_term || '',
    utm_ad: payload.utm_ad || '',
    campaign_id: payload.campaign_id || '',
    adset_id: payload.adset_id || '',
    ad_id: payload.ad_id || '',
    redirect_event_id: payload.redirect_event_id || '',
    customer_name: payload.customer_name || fallbackCustomer.name,
    customer_email: payload.customer_email || fallbackCustomer.email,
    customer_phone: onlyDigits(payload.customer_phone || fallbackCustomer.phone_number),
    customer_document: onlyDigits(payload.customer_document || fallbackCustomer.document),
    plan: '',
    value: 0,
    has_paid_main: false,
    has_paid_upsell: false,
    stop_remarketing: false
  };
}

async function safeAnswerCallback(queryId, options = {}) {
  try {
    await bot.answerCallbackQuery(queryId, options);
  } catch (err) {
    console.log('ANSWER CALLBACK ERROR:', err.response?.data || err.message || err);
  }
}

// ================= SUPABASE: USERS =================
async function upsertUser(user) {
  const payload = {
    chat_id: user.chat_id,
    fbc: user.fbc || '',
    fbp: user.fbp || '',
    ip: user.ip || '',
    ua: user.ua || '',
    lang: user.lang || '',
    screen: user.screen || '',
    tz: user.tz || '',
    referrer: user.referrer || '',
    host: user.host || '',
    path: user.path || '',
    utm_source: user.utm_source || '',
    utm_medium: user.utm_medium || '',
    utm_campaign: user.utm_campaign || '',
    utm_content: user.utm_content || '',
    utm_term: user.utm_term || '',
    utm_ad: user.utm_ad || '',
    campaign_id: user.campaign_id || '',
    adset_id: user.adset_id || '',
    ad_id: user.ad_id || '',
    redirect_event_id: user.redirect_event_id || '',
    customer_name: user.customer_name || '',
    customer_email: user.customer_email || '',
    customer_phone: user.customer_phone || '',
    customer_document: user.customer_document || '',
    plan: user.plan || '',
    value: Number(user.value || 0),
    has_paid_main: !!user.has_paid_main,
    has_paid_upsell: !!user.has_paid_upsell,
    stop_remarketing: !!user.stop_remarketing,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('users')
    .upsert(payload, { onConflict: 'chat_id' });

  if (error) throw error;
}

async function getUserByChatId(chat_id) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('chat_id', chat_id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function updateUserByChatId(chat_id, updates) {
  const { error } = await supabase
    .from('users')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('chat_id', chat_id);

  if (error) throw error;
}

// ================= SUPABASE: TRANSACTIONS =================
async function createOrUpdateTransaction(tx) {
  const payload = {
    tx_id: tx.txId,
    chat_id: tx.chat_id,
    amount: Number(tx.amount),
    status: tx.status || 'pending',
    upsell: !!tx.upsell,
    downsell: !!tx.downsell,
    pix_code: tx.pixCode || '',
    plan: tx.plan || '',
    meta_purchase_sent: !!tx.meta_purchase_sent,
    gateway: 'mercadopago',
    payment_method: tx.payment_method || 'pix',
    gateway_paid_at: tx.gateway_paid_at || null,
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('transactions')
    .upsert(payload, { onConflict: 'tx_id' });

  if (error) throw error;
}

async function getTransactionByTxId(txId) {
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('tx_id', txId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function markTransactionPaidDb(txId, paidAt = null) {
  const { error } = await supabase
    .from('transactions')
    .update({
      status: 'paid',
      paid_at: paidAt || new Date().toISOString(),
      gateway_paid_at: paidAt || null,
      updated_at: new Date().toISOString()
    })
    .eq('tx_id', txId);

  if (error) throw error;
}

// ================= SUPABASE: START PAYLOADS =================
async function createStartPayload(payload) {
  const token = generateShortStartToken();

  const { error } = await supabase
    .from('start_payloads')
    .insert({
      token,
      payload,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });

  if (error) throw error;
  return token;
}

async function consumeStartPayload(token) {
  const { data, error } = await supabase
    .from('start_payloads')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (error || !data) return null;

  await supabase.from('start_payloads').delete().eq('token', token);

  if (new Date(data.expires_at) < new Date()) return null;

  return data.payload;
}

async function cleanupOldStartPayloads() {
  try {
    await supabase
      .from('start_payloads')
      .delete()
      .lt('expires_at', new Date().toISOString());
  } catch (err) {
    console.log('CLEANUP ERROR:', err);
  }
}

// ================= SUPABASE: BUMPS =================
async function scheduleBumps(chat_id) {
  const now = Date.now();
  const rows = ORDER_BUMP_SCHEDULES.map(s => ({
    chat_id,
    bump_key: s.key,
    due_at: new Date(now + s.delayMs).toISOString(),
    sent: false
  }));

  const { error } = await supabase.from('scheduled_bumps').insert(rows);
  if (error) throw error;
}

async function stopAllUserBumps(chat_id) {
  const { error } = await supabase
    .from('scheduled_bumps')
    .delete()
    .eq('chat_id', chat_id);

  if (error) throw error;
}

async function getDueBumps(limit = 50) {
  const { data, error } = await supabase
    .from('scheduled_bumps')
    .select('*')
    .eq('sent', false)
    .lt('due_at', new Date().toISOString())
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function markBumpSent(id) {
  const { error } = await supabase
    .from('scheduled_bumps')
    .update({ sent: true, sent_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

// ================= META CONVERSION API =================
async function sendToMeta(eventName, user, customData = {}) {
  if (!META_TOKEN || !META_PIXEL_ID) return;

  const dedupeKey = `${eventName}_${user.chat_id}_${user.event_id || ''}`;
  if (processedMetaEvents.has(dedupeKey)) return;
  processedMetaEvents.add(dedupeKey);

  try {
    const userData = {
      em: [sha256(user.customer_email || '')],
      ph: [sha256(user.customer_phone || '')],
      client_ip_address: user.ip || '',
      client_user_agent: user.ua || '',
      fbc: user.fbc || '',
      fbp: user.fbp || ''
    };

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: nowSec(),
          action_source: 'website',
          event_id: user.event_id || uuidv4(),
          user_data: userData,
          custom_data: {
            currency: 'BRL',
            value: Number(user.value || 0),
            content_name: user.plan || '',
            ...customData
          }
        }
      ],
      test_event_code: META_TEST_EVENT_CODE || undefined
    };

    await axios.post(
      `https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`,
      payload,
      { timeout: 15000 }
    );
  } catch (err) {
    processedMetaEvents.delete(dedupeKey);
    console.log('META ERROR:', err.response?.data || err.message);
  }
}

// ================= MERCADO PAGO =================
async function createMercadoPagoPix(user, amount, options = {}) {
  const {
    isUpsell = false,
    isDownsell = false
  } = options;

  const customer = {
    first_name: user.customer_name.split(' ')[0] || DEFAULT_CUSTOMER_NAME.split(' ')[0],
    last_name: user.customer_name.split(' ').slice(1).join(' ') || DEFAULT_CUSTOMER_NAME.split(' ').slice(1).join(' '),
    email: user.customer_email || `user_${user.chat_id}@${DEFAULT_CUSTOMER_EMAIL_DOMAIN}`,
    phone: {
      area_code: user.customer_phone.substring(0, 2) || '11',
      number: user.customer_phone.substring(2) || '999999999'
    },
    identification: {
      type: 'CPF',
      number: user.customer_document || DEFAULT_CUSTOMER_DOCUMENT
    }
  };

  const body = {
    transaction_amount: amount,
    description: isUpsell
      ? 'Tarifa de Segurança'
      : isDownsell
        ? 'Oferta Especial'
        : 'Acesso VIP',
    payment_method_id: 'pix',
    payer: {
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      identification: customer.identification,
      phone: customer.phone
    },
    external_reference: user.chat_id.toString(),
    notification_url: `${BASE_URL}${PAYMENT_PATH}`,
    metadata: {
      chat_id: user.chat_id,
      isUpsell: isUpsell,
      isDownsell: isDownsell,
      plan: user.plan || ''
    }
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`,
    'X-Idempotency-Key': uuidv4()
  };

  let response;
  try {
    response = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      body,
      {
        headers,
        timeout: 25000
      }
    );
  } catch (err) {
    if (err.response?.status === 401 && MERCADOPAGO_CLIENT_ID && MERCADOPAGO_CLIENT_SECRET) {
      await refreshMercadoPagoToken();
      headers.Authorization = `Bearer ${MERCADOPAGO_ACCESS_TOKEN}`;
      response = await axios.post(
        'https://api.mercadopago.com/v1/payments',
        body,
        {
          headers,
          timeout: 25000
        }
      );
    } else {
      throw err;
    }
  }

  const data = response.data || {};
  const txId = String(data.id || '').trim();
  const pixCode = data.point_of_interaction?.transaction_data?.qr_code || '';
  const qrCodeImage = data.point_of_interaction?.transaction_data?.qr_code_base64 || '';

  if (!txId) {
    throw new Error(`Resposta Mercado Pago sem ID da transação: ${JSON.stringify(data)}`);
  }

  if (!pixCode) {
    console.log('MERCADOPAGO WARNING: resposta sem pix_code claro:', data);
    throw new Error(`Resposta Mercado Pago sem código PIX: ${JSON.stringify(data)}`);
  }

  return {
    txId,
    pixCode,
    qrCodeImage,
    raw: data
  };
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

// ================= COPY DO FUNIL =================
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

// ================= CHECKOUT UI =================
async function sendPixCheckoutMessage(chat_id, txId, amount, pixCode) {
  const introMessage = [
    '✅ <b>Como realizar o pagamento:</b>',
    '1. Abra o aplicativo do seu banco.',
    '2. Selecione a opção "Pagar" ou "PIX".',
    '3. Escolha "PIX Copia e Cola".',
    '4. Cole a chave que está abaixo e finalize o pagamento com segurança.',
    '',
    'Amor, falta pouco! 😈',
    'Gere o PIX abaixo para liberar seu acesso imediatamente.',
    '',
    '<b>NÃO ESQUEÇA DE APERTAR EM CONFERIR PAGAMENTO APÓS FINALIZAR!!</b>',
    '',
    '👇 Toque no código para copiar e pague no seu app de banco.',
    'Assim que confirmar, eu te chamo aqui na hora!',
    '',
    `<b>Valor:</b> R$ ${formatBRL(amount)}`
  ].join('\n');

  await bot.sendMessage(chat_id, introMessage, {
    parse_mode: 'HTML'
  });

  await bot.sendMessage(chat_id, 'Copie o código abaixo:');

  await bot.sendMessage(chat_id, `<code>${escapeHtml(pixCode)}</code>`, {
    parse_mode: 'HTML'
  });

  await bot.sendMessage(chat_id, 'Estou segurando sua vaga por alguns minutos... ⏳');

  const keyboard = [
    [{ text: '✅ Verificar Status', callback_data: `check_payment:${txId}` }]
  ];

  if (pixCode && pixCode.length <= 256) {
    keyboard.push([
      {
        text: '📋 Copiar Código',
        copy_text: {
          text: pixCode
        }
      }
    ]);
  } else {
    keyboard.push([
      {
        text: '📋 Copiar Código',
        callback_data: `copy_fallback:${txId}`
      }
    ]);
  }

  await bot.sendMessage(chat_id, 'Escolha uma opção abaixo:', {
    reply_markup: {
      inline_keyboard: keyboard
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

    const { txId, pixCode, raw } = await createMercadoPagoPix(user, amount, {
      isUpsell,
      isDownsell
    });

    await createOrUpdateTransaction({
      txId,
      chat_id,
      amount,
      upsell: isUpsell,
      downsell: isDownsell,
      pixCode,
      plan: user.plan || '',
      status: 'pending',
      payment_method: 'pix'
    });

    console.log('MERCADOPAGO TRANSACTION OK:', raw);

    await sendPixCheckoutMessage(chat_id, txId, amount, pixCode);
  } catch (err) {
    console.log('PAYMENT ERROR FULL:', {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });

    let errorMsg = '❌ Erro ao gerar pagamento.';
    if (err.response?.data?.message?.includes('Collector user without key enabled')) {
      errorMsg = '⚠️ <b>Erro de Configuração:</b>\n\nA conta do Mercado Pago não possui uma <b>Chave PIX</b> cadastrada.\n\nPara resolver:\n1. Acesse o app ou site do Mercado Pago.\n2. Vá em "Seu Perfil" > "Suas Chaves PIX".\n3. Cadastre uma chave (pode ser aleatória).\n4. Tente novamente aqui.';
    }

    await bot.sendMessage(chat_id, errorMsg, { parse_mode: 'HTML' });
  }
}

// ================= BUMP WORKER =================
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

async function runScheduledBumps() {
  try {
    const bumps = await getDueBumps(50);

    for (const bump of bumps) {
      try {
        const user = await getUserByChatId(bump.chat_id);

        if (!user || user.has_paid_main || user.has_paid_upsell || user.stop_remarketing) {
          await markBumpSent(bump.id);
          continue;
        }

        const index = ORDER_BUMP_SCHEDULES.findIndex(x => x.key === bump.bump_key);

        await sendOptionalVideo(bump.chat_id, VIDEO_BUMP, `AUTO BUMP VIDEO ${bump.bump_key}`);

        await bot.sendMessage(bump.chat_id, `
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

        await markBumpSent(bump.id);
      } catch (err) {
        console.log('BUMP SEND ERROR:', err.response?.data || err.message || err);
      }
    }
  } catch (err) {
    console.log('BUMP WORKER ERROR:', err.response?.data || err.message || err);
  }
}

// ================= ROTA PARA TOKEN CURTO =================
app.post('/prepare-start', async (req, res) => {
  try {
    const payload = req.body || {};
    const token = await createStartPayload(payload);
    console.log('TOKEN GERADO:', token);
    return res.status(200).json({ token });
  } catch (err) {
    console.log('PREPARE START ERROR:', err.response?.data || err.message || err);
    return res.status(500).json({ error: 'prepare_start_failed' });
  }
});

// ================= TELEGRAM START =================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;
    const startToken = (match?.[1] || '').trim();

    console.log('START DEBUG:', {
      chat_id,
      text: msg.text,
      startToken
    });

    let payload = {};

    if (startToken) {
      const dbPayload = await consumeStartPayload(startToken);
      if (dbPayload) {
        payload = dbPayload;
      }
    }

    console.log('PAYLOAD DECODED:', payload);

    const user = buildUserRecord(chat_id, payload);

    await upsertUser(user);

    await sendToMeta('ViewContent', {
      ...user,
      event_id: uuidv4()
    });

    await stopAllUserBumps(chat_id).catch(() => {});
    await sendPlanMessage(chat_id);
    await scheduleBumps(chat_id);
  } catch (err) {
    console.log('START ERROR:', err.response?.data || err.message || err);
  }
});

// ================= TELEGRAM CALLBACKS =================
bot.on('callback_query', async (query) => {
  const chat_id = query.message.chat.id;
  const data = query.data;

  try {
    if (!lockAction(`cb_${chat_id}_${data}`, 1500)) {
      return await safeAnswerCallback(query.id, { text: 'Aguarde um instante...' });
    }

    if (data === 'plan_week') {
      await updateUserByChatId(chat_id, { plan: '1 SEMANA', value: 7.42 });
      await sendOrderBumpMessage(chat_id);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'plan_vip') {
      await updateUserByChatId(chat_id, { plan: 'VIP VITALÍCIO', value: 15.42 });
      await sendOrderBumpMessage(chat_id);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'plan_full') {
      await updateUserByChatId(chat_id, { plan: 'VITALÍCIO + PASTAS', value: 23.42 });
      await sendOrderBumpMessage(chat_id);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'bump_yes') {
      const user = await getUserByChatId(chat_id);
      const newValue = roundMoney((user?.value || 0) + 4.99);

      await updateUserByChatId(chat_id, {
        value: newValue,
        plan: `${user.plan} + BUMP`
      });

      const updatedUser = await getUserByChatId(chat_id);
      await goToPayment(chat_id, updatedUser);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'bump_no') {
      const user = await getUserByChatId(chat_id);
      await goToPayment(chat_id, user);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'upsell_buy') {
      const user = await getUserByChatId(chat_id);
      await goToPayment(chat_id, user, { isUpsell: true, forcedAmount: 10 });
      return await safeAnswerCallback(query.id);
    }

    if (data === 'remarketing_pay_now') {
      const user = await getUserByChatId(chat_id);
      await goToPayment(chat_id, user);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'remarketing_no') {
      await sendDownsellMessage(chat_id);
      return await safeAnswerCallback(query.id);
    }

    if (data === 'downsell_view') {
      const user = await getUserByChatId(chat_id);
      const downsellValue = roundMoney((user?.value || 0) * 0.7);

      await updateUserByChatId(chat_id, {
        value: downsellValue,
        plan: `${user.plan} (DOWNSELL)`
      });

      const updatedUser = await getUserByChatId(chat_id);
      await goToPayment(chat_id, updatedUser, { isDownsell: true });
      return await safeAnswerCallback(query.id);
    }

    if (data === 'downsell_exit') {
      await bot.sendMessage(chat_id, 'Tudo bem.');
      return await safeAnswerCallback(query.id);
    }

    if (data.startsWith('check_payment:')) {
      const txId = data.split(':')[1];
      const tx = await getTransactionByTxId(txId);

      if (!tx) {
        return await safeAnswerCallback(query.id, {
          text: 'Transação não encontrada.',
          show_alert: true
        });
      }

      if (tx.status === 'paid') {
        return await safeAnswerCallback(query.id, {
          text: 'Pagamento já confirmado!',
          show_alert: true
        });
      }

      const paymentResponse = await axios.get(`https://api.mercadopago.com/v1/payments/${txId}`, {
        headers: { Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}` },
        timeout: 15000
      });

      if (paymentResponse.data.status === 'approved') {
        return await safeAnswerCallback(query.id, {
          text: 'Pagamento confirmado com sucesso!',
          show_alert: true
        });
      }

      return await safeAnswerCallback(query.id, {
        text: 'Pagamento ainda não identificado. Tente em alguns instantes.',
        show_alert: true
      });
    }

    if (data.startsWith('copy_fallback:')) {
      const txId = data.split(':')[1];
      const tx = await getTransactionByTxId(txId);

      if (tx && tx.pix_code) {
        await bot.sendMessage(
          chat_id,
          `Aqui está o código para copiar:\n\n<code>${escapeHtml(tx.pix_code)}</code>`,
          { parse_mode: 'HTML' }
        );
      }

      return await safeAnswerCallback(query.id, { text: 'Código enviado.' });
    }

    return await safeAnswerCallback(query.id);
  } catch (err) {
    console.log('CALLBACK ERROR:', err.response?.data || err.message || err);
    return await safeAnswerCallback(query.id, {
      text: 'Ocorreu um erro. Tente novamente.',
      show_alert: true
    });
  }
});

// ================= ROUTE TELEGRAM =================
app.post(TELEGRAM_PATH, (req, res) => {
  try {
    bot.processUpdate(req.body);
    return res.sendStatus(200);
  } catch (err) {
    console.log('TELEGRAM ROUTE ERROR:', err);
    return res.sendStatus(200);
  }
});

// ================= ROUTE PAYMENT WEBHOOK =================
app.post(PAYMENT_PATH, async (req, res) => {
  try {
    const body = req.body || {};
    const query = req.query || {};

    const topic = body.type || query.topic || body.topic;

    if (topic !== 'payment') {
      console.log('WEBHOOK TOPIC IGNORED:', topic);
      return res.sendStatus(200);
    }

    const paymentId = String(
      query['data.id'] ||
      query.id ||
      body?.data?.id ||
      body?.resource?.split('/').pop() ||
      ''
    ).trim();

    if (!paymentId || paymentId === '123456') {
      console.log('WEBHOOK TEST OR EMPTY ID RECEIVED:', paymentId);
      return res.sendStatus(200);
    }

    if (MERCADOPAGO_WEBHOOK_SECRET) {
      const rawSignature = String(req.headers['x-signature'] || '');
      const xRequestId = String(req.headers['x-request-id'] || '');

      if (rawSignature && xRequestId) {
        const signatureParts = rawSignature.split(',').reduce((acc, item) => {
          const [key, value] = item.split('=');
          if (key && value) acc[key.trim()] = value.trim();
          return acc;
        }, {});

        const ts = signatureParts.ts || '';
        const receivedHash = signatureParts.v1 || '';
        const manifestParts = [];

        if (paymentId) {
          const normalizedPaymentId = /^[a-z0-9]+$/i.test(paymentId)
            ? paymentId.toLowerCase()
            : paymentId;
          manifestParts.push(`id:${normalizedPaymentId};`);
        }

        if (xRequestId) manifestParts.push(`request-id:${xRequestId};`);
        if (ts) manifestParts.push(`ts:${ts};`);

        const manifest = manifestParts.join('');
        const expectedHash = crypto
          .createHmac('sha256', MERCADOPAGO_WEBHOOK_SECRET)
          .update(manifest)
          .digest('hex');

        if (receivedHash && expectedHash !== receivedHash) {
          console.log('WEBHOOK SECRET INVALID');
          return res.sendStatus(401);
        }
      }
    }

    let paymentResponse;
    try {
      paymentResponse = await axios.get(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        {
          headers: { Authorization: `Bearer ${MERCADOPAGO_ACCESS_TOKEN}` },
          timeout: 25000
        }
      );
    } catch (err) {
      if (err.response?.status === 404) {
        console.log('WEBHOOK PAYMENT NOT FOUND (TEST?):', paymentId);
        return res.sendStatus(200);
      }
      throw err;
    }

    const payment = paymentResponse.data || {};
    const txId = String(payment.id || paymentId);
    const status = payment.status;
    const paidAt = payment.date_approved || payment.date_last_updated || null;

    if (!txId || processedPayments.has(txId)) {
      return res.sendStatus(200);
    }

    const tx = await getTransactionByTxId(txId);
    if (!tx || tx.status === 'paid') {
      return res.sendStatus(200);
    }

    if (status === 'approved') {
      processedPayments.add(txId);

      await markTransactionPaidDb(
        txId,
        paidAt ? new Date(paidAt).toISOString() : new Date().toISOString()
      );

      const user = await getUserByChatId(tx.chat_id);
      if (!user) {
        return res.sendStatus(200);
      }

      if (!tx.upsell) {
        await updateUserByChatId(tx.chat_id, {
          has_paid_main: true,
          stop_remarketing: true
        });

        await stopAllUserBumps(tx.chat_id);

        await sendToMeta('Purchase', {
          ...user,
          value: tx.amount,
          plan: tx.plan || user.plan || '',
          event_id: uuidv4()
        });

        await bot.sendMessage(
          tx.chat_id,
          `✅ PAGAMENTO CONFIRMADO!\n\nSeu acesso foi liberado com sucesso 🔥\n\nToque no botão abaixo para entrar agora mesmo:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔒 Acessar conteúdo', url: 'https://t.me/suporterayssabot' }]
              ]
            }
          }
        );

        await sendUpsellMessage(tx.chat_id);
      } else {
        await updateUserByChatId(tx.chat_id, {
          has_paid_upsell: true,
          stop_remarketing: true
        });

        await stopAllUserBumps(tx.chat_id);

        await bot.sendMessage(
          tx.chat_id,
          `🚀 ACESSO TOTAL LIBERADO!\n\nToque no botão abaixo para acessar seu conteúdo agora mesmo.`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔒 Acessar conteúdo', url: 'https://t.me/suporterayssabot' }]
              ]
            }
          }
        );
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log('WEBHOOK ERROR:', err.response?.data || err.message || err);
    return res.sendStatus(200);
  }
});

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

// ================= SET COMMANDS =================
async function setupCommands() {
  try {
    await bot.setMyCommands([
      { command: 'start', description: '🚀 Iniciar o bot' },
      { command: 'status', description: '📊 Ver minha assinatura' },
      { command: 'suporte', description: '💬 Falar com suporte' }
    ]);
  } catch (err) {
    console.log('SET COMMANDS ERROR:', err.response?.data || err.message || err);
  }
}

// ================= WEBHOOK SETUP =================
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

// ================= WORKERS =================
setInterval(runScheduledBumps, 60 * 1000);
setInterval(cleanupOldStartPayloads, 6 * 60 * 60 * 1000);

// ================= SERVER =================
app.listen(PORT, async () => {
  console.log(`BOT ONLINE NA PORTA ${PORT}`);
  await setupTelegramWebhook();
  await setupCommands();
});
