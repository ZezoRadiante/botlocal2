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

// ================= TRIBOPAY =================
const TRIBOPAY_BASE_URL = (process.env.TRIBOPAY_BASE_URL || 'https://api.tribopay.com.br/api').replace(/\/+$/, '');
const TRIBOPAY_API_TOKEN = process.env.TRIBOPAY_API_TOKEN;
const TRIBOPAY_OFFER_HASH = process.env.TRIBOPAY_OFFER_HASH;
const TRIBOPAY_POSTBACK_SECRET = process.env.TRIBOPAY_POSTBACK_SECRET || '';

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
if (!TRIBOPAY_API_TOKEN) throw new Error('TRIBOPAY_API_TOKEN não configurado');
if (!TRIBOPAY_OFFER_HASH) throw new Error('TRIBOPAY_OFFER_HASH não configurado');
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
  allowedHeaders: ['Content-Type', 'x-tribopay-secret']
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

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function centsToMoney(cents) {
  return roundMoney(Number(cents || 0) / 100);
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
    .update(String(value).trim().toLowerCase())
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

function extractTriboPixCode(data) {
  return (
    data?.pix?.pix_qr_code ||
    data?.pix_code ||
    data?.pixCode ||
    data?.pix?.payload ||
    data?.pix?.code ||
    data?.pix_qr_code ||
    data?.qr_code ||
    data?.qrCode ||
    data?.digitable_line ||
    data?.copy_paste ||
    data?.copyAndPaste ||
    data?.payment_data?.pix_code ||
    data?.payment_data?.qr_code ||
    data?.data?.pix_code ||
    data?.data?.pix?.payload ||
    null
  );
}

function extractTriboQrCodeImage(data) {
  return (
    data?.qr_code_base64 ||
    data?.pix?.qr_code_base64 ||
    data?.pix?.qr_code_image ||
    data?.payment_data?.qr_code_base64 ||
    data?.data?.qr_code_base64 ||
    null
  );
}

function extractTriboTransactionHash(data) {
  return (
    data?.transaction_hash ||
    data?.hash ||
    data?.id ||
    data?.data?.transaction_hash ||
    data?.data?.hash ||
    data?.data?.id ||
    null
  );
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
    gateway: 'tribopay',
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
      used: false
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

  if (error) throw error;
  if (!data) return null;

  if (!data.used) {
    await supabase
      .from('start_payloads')
      .update({ used: true })
      .eq('token', token);
  }

  return data.payload || null;
}

async function cleanupOldStartPayloads() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('start_payloads')
    .delete()
    .lt('created_at', cutoff);

  if (error) {
    console.log('START PAYLOAD CLEANUP ERROR:', error.message);
  }
}

// ================= SUPABASE: BUMPS =================
async function scheduleUserBumpsInDb(chat_id) {
  const now = Date.now();

  const rows = ORDER_BUMP_SCHEDULES.map((item) => ({
    chat_id,
    bump_key: item.key,
    run_at: new Date(now + item.delayMs).toISOString(),
    sent: false
  }));

  const { error } = await supabase
    .from('scheduled_bumps')
    .upsert(rows, { onConflict: 'chat_id,bump_key' });

  if (error) throw error;
}

async function stopAllUserBumps(chat_id) {
  const { error } = await supabase
    .from('scheduled_bumps')
    .update({
      sent: true,
      sent_at: new Date().toISOString()
    })
    .eq('chat_id', chat_id)
    .eq('sent', false);

  if (error) throw error;
}

async function getDueBumps(limit = 50) {
  const { data, error } = await supabase
    .from('scheduled_bumps')
    .select('*')
    .eq('sent', false)
    .lte('run_at', new Date().toISOString())
    .limit(limit);

  if (error) throw error;
  return data || [];
}

async function markBumpSent(id) {
  const { error } = await supabase
    .from('scheduled_bumps')
    .update({
      sent: true,
      sent_at: new Date().toISOString()
    })
    .eq('id', id);

  if (error) throw error;
}

// ================= META =================
async function sendToMeta(event_name, user, overrideEventId = null) {
  const metaEventId = overrideEventId || user.event_id || uuidv4();
  const dedupeKey = `${event_name}:${metaEventId}`;

  if (processedMetaEvents.has(dedupeKey)) return;
  processedMetaEvents.add(dedupeKey);

  try {
    const userData = {
      client_ip_address: user.ip || '',
      client_user_agent: user.ua || '',
      fbc: user.fbc || '',
      fbp: user.fbp || ''
    };

    if (user.chat_id) {
      userData.external_id = sha256(user.chat_id);
    }

    if (user.customer_email) {
      userData.em = sha256(user.customer_email);
    }

    if (user.customer_phone) {
      userData.ph = sha256(user.customer_phone);
    }

    if (user.customer_document) {
      userData.db = sha256(user.customer_document);
    }

    const payload = {
      data: [
        {
          event_name,
          event_time: nowSec(),
          event_id: metaEventId,
          action_source: 'website',
          user_data: userData,
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
            ad_id: user.ad_id || '',
            plan: user.plan || ''
          }
        }
      ]
    };

    if (META_TEST_EVENT_CODE) {
      payload.test_event_code = META_TEST_EVENT_CODE;
    }

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

// ================= TRIBOPAY =================
async function createTriboPayPix(user, amount, options = {}) {
  const {
    isUpsell = false,
    isDownsell = false
  } = options;

  const customer = {
    name: user.customer_name || DEFAULT_CUSTOMER_NAME,
    email: user.customer_email || `user_${user.chat_id}@${DEFAULT_CUSTOMER_EMAIL_DOMAIN}`,
    phone_number: onlyDigits(user.customer_phone || DEFAULT_CUSTOMER_PHONE),
    document: onlyDigits(user.customer_document || DEFAULT_CUSTOMER_DOCUMENT)
  };

  const cents = toCents(amount);

  const body = {
    amount: cents,
    offer_hash: TRIBOPAY_OFFER_HASH,
    payment_method: 'pix',
    customer,
    cart: [
      {
        product_hash: TRIBOPAY_OFFER_HASH,
        title: isUpsell
          ? 'Tarifa de Segurança'
          : isDownsell
            ? 'Oferta Especial'
            : 'Acesso VIP',
        cover: null,
        price: cents,
        quantity: 1,
        operation_type: 1,
        tangible: false
      }
    ],
    expire_in_days: 1,
    transaction_origin: 'api',
    tracking: {
      src: user.host || '',
      utm_source: user.utm_source || '',
      utm_medium: user.utm_medium || '',
      utm_campaign: user.utm_campaign || '',
      utm_term: user.utm_term || '',
      utm_content: user.utm_content || ''
    },
    postback_url: `${BASE_URL}${PAYMENT_PATH}`
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  if (TRIBOPAY_POSTBACK_SECRET) {
    headers['x-tribopay-secret'] = TRIBOPAY_POSTBACK_SECRET;
  }

  const response = await axios.post(
    `${TRIBOPAY_BASE_URL}/public/v1/transactions?api_token=${encodeURIComponent(TRIBOPAY_API_TOKEN)}`,
    body,
    {
      headers,
      timeout: 25000
    }
  );

  const data = response.data || {};
  const txId = extractTriboTransactionHash(data);
  const pixCode = extractTriboPixCode(data);
  const qrCodeImage = extractTriboQrCodeImage(data);

  if (!txId) {
    throw new Error(`Resposta TriboPay sem transaction_hash: ${JSON.stringify(data)}`);
  }

  if (!pixCode) {
    console.log('TRIBOPAY WARNING: resposta sem pix_code claro:', data);
    throw new Error(`Resposta TriboPay sem código PIX: ${JSON.stringify(data)}`);
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

    const { txId, pixCode, raw } = await createTriboPayPix(user, amount, {
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

    console.log('TRIBOPAY TRANSACTION OK:', raw);

    await sendPixCheckoutMessage(chat_id, txId, amount, pixCode);
  } catch (err) {
    console.log('PAYMENT ERROR FULL:', {
      message: err.message,
      status: err.response?.status,
      data: err.response?.data
    });

    await bot.sendMessage(chat_id, '❌ Erro ao gerar pagamento.');
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
    }, user.redirect_event_id || uuidv4());

    await sendPlanMessage(chat_id);
    await scheduleUserBumpsInDb(chat_id);
  } catch (err) {
    console.log('START ERROR:', err.response?.data || err.message || err);
    try {
      await bot.sendMessage(msg.chat.id, '❌ Erro ao iniciar.');
    } catch {}
  }
});

// ================= COMANDOS EXTRAS =================
bot.onText(/^\/status$/, async (msg) => {
  try {
    const user = await getUserByChatId(msg.chat.id);

    if (!user) {
      return await bot.sendMessage(msg.chat.id, '❌ Não encontrei seu cadastro. Envie /start.');
    }

    return await bot.sendMessage(msg.chat.id, `
📊 STATUS DA SUA CONTA

Plano: ${user.plan || 'Não definido'}
Pagamento principal: ${user.has_paid_main ? '✅ Pago' : '❌ Pendente'}
Upsell: ${user.has_paid_upsell ? '✅ Pago' : '❌ Não pago'}
`);
  } catch (err) {
    console.log('STATUS ERROR:', err);
  }
});

bot.onText(/^\/suporte$/, async (msg) => {
  try {
    await bot.sendMessage(msg.chat.id, '💬 Suporte em breve.');
  } catch (err) {
    console.log('SUPORTE ERROR:', err);
  }
});

// ================= TELEGRAM CALLBACK =================
bot.on('callback_query', async (query) => {
  try {
    if (!query?.message?.chat?.id) return;

    const chat_id = query.message.chat.id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const lockKey = `${chat_id}:${data}`;
    if (!lockAction(lockKey)) return;

    const user = await getUserByChatId(chat_id);
    if (!user) {
      return await bot.sendMessage(chat_id, '❌ Não encontrei seu cadastro. Envie /start novamente.');
    }

    if (data === 'plan_week') {
      await updateUserByChatId(chat_id, {
        value: 7.42,
        plan: 'week'
      });

      await sendToMeta('InitiateCheckout', {
        ...user,
        value: 7.42,
        plan: 'week',
        event_id: uuidv4()
      });

      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'plan_vip') {
      await updateUserByChatId(chat_id, {
        value: 15.42,
        plan: 'vip'
      });

      await sendToMeta('InitiateCheckout', {
        ...user,
        value: 15.42,
        plan: 'vip',
        event_id: uuidv4()
      });

      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'plan_full') {
      await updateUserByChatId(chat_id, {
        value: 23.42,
        plan: 'full'
      });

      await sendToMeta('InitiateCheckout', {
        ...user,
        value: 23.42,
        plan: 'full',
        event_id: uuidv4()
      });

      return await sendOrderBumpMessage(chat_id);
    }

    if (data === 'bump_yes') {
      const newValue = roundMoney(Number(user.value || 0) + 4.99);

      await updateUserByChatId(chat_id, {
        value: newValue
      });

      return await goToPayment(chat_id, {
        ...user,
        value: newValue
      }, { isUpsell: false });
    }

    if (data === 'bump_no') {
      return await goToPayment(chat_id, user, { isUpsell: false });
    }

    if (data === 'upsell_buy') {
      return await goToPayment(chat_id, {
        ...user,
        value: 10
      }, {
        isUpsell: true,
        forcedAmount: 10
      });
    }

    if (data === 'remarketing_pay_now') {
      let targetUser = { ...user };

      if (!targetUser.plan) {
        targetUser.plan = 'vip';
        targetUser.value = 15.42;

        await updateUserByChatId(chat_id, {
          plan: 'vip',
          value: 15.42
        });
      }

      await sendToMeta('InitiateCheckout', {
        ...targetUser,
        event_id: uuidv4()
      });

      return await goToPayment(chat_id, targetUser, { isUpsell: false });
    }

    if (data === 'remarketing_no') {
      await updateUserByChatId(chat_id, {
        stop_remarketing: true
      });

      await stopAllUserBumps(chat_id);
      return await bot.sendMessage(chat_id, 'Tudo bem.');
    }

    if (data === 'check_payment' || data.startsWith('check_payment:')) {
      const txId = data.includes(':') ? data.split(':')[1] : null;
      const tx = txId ? await getTransactionByTxId(txId) : null;

      if (!tx) {
        return await bot.sendMessage(chat_id, '❌ Não encontrei esse pagamento. Gere um novo PIX.');
      }

      if (tx.status === 'paid') {
        return await bot.sendMessage(chat_id, '✅ Seu pagamento já foi confirmado.');
      }

      return await bot.sendMessage(chat_id, '⏳ Ainda não localizei a confirmação. Se você acabou de pagar, aguarde alguns segundos e toque novamente em verificar status.');
    }

    if (data === 'copy_fallback' || data.startsWith('copy_fallback:')) {
      const txId = data.includes(':') ? data.split(':')[1] : null;
      const tx = txId ? await getTransactionByTxId(txId) : null;

      if (!tx) {
        return await bot.sendMessage(chat_id, '❌ Não encontrei esse código. Gere um novo PIX.');
      }

      return await bot.sendMessage(
        chat_id,
        '⚠️ O Telegram não permitiu o botão de cópia automática para esse código. Toque e segure no bloco do PIX para copiar manualmente.'
      );
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

    if (TRIBOPAY_POSTBACK_SECRET) {
      const secretHeader = req.headers['x-tribopay-secret'];
      if (secretHeader !== TRIBOPAY_POSTBACK_SECRET) {
        console.log('WEBHOOK SECRET INVALID');
        return res.sendStatus(401);
      }
    }

    const txId =
      body.transaction_hash ||
      body?.data?.transaction_hash ||
      body?.transaction?.transaction_hash ||
      body?.hash ||
      body?.id ||
      null;

    const status =
      body.status ||
      body?.data?.status ||
      body?.transaction?.status ||
      '';

    const paidAt =
      body.paid_at ||
      body?.data?.paid_at ||
      body?.transaction?.paid_at ||
      null;

    const paymentMethod =
      body.payment_method ||
      body?.data?.payment_method ||
      body?.transaction?.payment_method ||
      'pix';

    if (!txId) {
      console.log('WEBHOOK WITHOUT TXID:', body);
      return res.sendStatus(200);
    }

    if (processedPayments.has(txId)) {
      return res.sendStatus(200);
    }

    const tx = await getTransactionByTxId(txId);
    if (!tx) {
      console.log('WEBHOOK TX NOT FOUND:', { txId, status, body });
      return res.sendStatus(200);
    }

    if (tx.status === 'paid') {
      return res.sendStatus(200);
    }

    const paid = status === 'paid';

    if (!paid) {
      console.log('WEBHOOK NOT PAID YET:', { txId, status, paymentMethod });
      return res.sendStatus(200);
    }

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

      await bot.sendMessage(tx.chat_id, `
✅ PAGAMENTO CONFIRMADO!

Seu acesso está sendo liberado...
`);

      await sendUpsellMessage(tx.chat_id);
    } else {
      await updateUserByChatId(tx.chat_id, {
        has_paid_upsell: true,
        stop_remarketing: true
      });

      await stopAllUserBumps(tx.chat_id);

      await bot.sendMessage(tx.chat_id, `
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
  await setupCommands();
});
