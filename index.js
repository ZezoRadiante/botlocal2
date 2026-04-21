const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

// ================= MERCADO PAGO =================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const mpPayment = new Payment(mpClient);

// ================= META =================
const META_PIXEL_ID = process.env.META_PIXEL_ID || '1505014021315132';
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
if (!MP_ACCESS_TOKEN) throw new Error('MP_ACCESS_TOKEN não configurado');
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
  allowedHeaders: ['Content-Type']
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
const reconcilingTxIds = new Set();

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

function buildFallbackCustomer(chat_id) {
  const domain = String(DEFAULT_CUSTOMER_EMAIL_DOMAIN || 'gmail.com')
    .replace(/^@+/, '')
    .trim();

  return {
    name: DEFAULT_CUSTOMER_NAME || 'Cliente Telegram',
    email: `user${chat_id}@${domain}`,
    phone_number: onlyDigits(DEFAULT_CUSTOMER_PHONE) || '11999999999',
    document: onlyDigits(DEFAULT_CUSTOMER_DOCUMENT) || '12345678901'
  };
}

// ================= SUPABASE DB OPS =================
async function upsertUser(user) {
  const { error } = await supabase
    .from('users')
    .upsert(user, { onConflict: 'chat_id' });
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
    .update(updates)
    .eq('chat_id', chat_id);
  if (error) throw error;
}

async function createOrUpdateTransaction(tx) {
  const { error } = await supabase
    .from('transactions')
    .upsert(tx, { onConflict: 'tx_id' });
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

async function markTransactionPaidDb(txId, paidAt) {
  const { error } = await supabase
    .from('transactions')
    .update({
      status: 'paid',
      paid_at: paidAt
    })
    .eq('tx_id', txId);
  if (error) throw error;
}

async function markTransactionMetaSent(txId) {
  const { error } = await supabase
    .from('transactions')
    .update({ meta_sent: true })
    .eq('tx_id', txId);
  if (error) throw error;
}

async function getRecentPendingTransactions(minutes = 30) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('status', 'pending')
    .gte('created_at', cutoff);
  if (error) throw error;
  return data || [];
}

// ================= SUPABASE: START PAYLOADS =================
async function createStartPayload(payload) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { error } = await supabase
    .from('start_payloads')
    .insert({ token, payload, used: false });
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
  if (error) console.log('START PAYLOAD CLEANUP ERROR:', error.message);
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
    .update({ sent: true, sent_at: new Date().toISOString() })
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
    .update({ sent: true, sent_at: new Date().toISOString() })
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
    if (user.chat_id) userData.external_id = sha256(user.chat_id);
    if (user.customer_email) userData.em = sha256(user.customer_email);
    if (user.customer_phone) userData.ph = sha256(user.customer_phone);
    if (user.customer_document) userData.db = sha256(user.customer_document);

    const payload = {
      data: [{
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
      }]
    };
    if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;
    await axios.post(`https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`, payload, { timeout: 15000 });
  } catch (err) {
    processedMetaEvents.delete(dedupeKey);
    console.log('META ERROR:', err.response?.data || err.message || err);
    throw err;
  }
}

// ================= MERCADO PAGO =================
async function createMPPix(user, amount, options = {}) {
  const { isUpsell = false, isDownsell = false } = options;
  const fallback = buildFallbackCustomer(user.chat_id);
  
  const body = {
    transaction_amount: roundMoney(amount),
    description: isUpsell ? 'Tarifa de Segurança' : (isDownsell ? 'Oferta Especial' : 'Acesso VIP'),
    payment_method_id: 'pix',
    payer: {
      email: user.customer_email || fallback.email,
      first_name: user.customer_name?.split(' ')[0] || 'Cliente',
      last_name: user.customer_name?.split(' ').slice(1).join(' ') || 'Telegram',
      identification: {
        type: 'CPF',
        number: onlyDigits(user.customer_document || fallback.document)
      }
    },
    notification_url: `${BASE_URL}${PAYMENT_PATH}`,
    external_reference: String(user.chat_id)
  };

  const response = await mpPayment.create({ body, requestOptions: { idempotencyKey: uuidv4() } });
  
  if (!response || !response.id) {
    throw new Error(`Erro ao criar pagamento no Mercado Pago: ${JSON.stringify(response)}`);
  }

  return {
    txId: String(response.id),
    pixCode: response.point_of_interaction.transaction_data.qr_code,
    qrCodeImage: response.point_of_interaction.transaction_data.qr_code_base64,
    raw: response
  };
}

async function getMPTransactionStatus(txId) {
  const response = await mpPayment.get({ id: txId });
  return response;
}

// ================= CONFIRMAÇÃO CENTRAL =================
async function confirmApprovedTransaction(tx, paidAt = null, source = 'unknown') {
  const freshTx = await getTransactionByTxId(tx.tx_id);
  if (!freshTx || freshTx.status === 'paid') return;

  console.log('CONFIRMING TX:', { txId: tx.tx_id, source, paidAt });
  await markTransactionPaidDb(tx.tx_id, paidAt ? new Date(paidAt).toISOString() : new Date().toISOString());

  const user = await getUserByChatId(tx.chat_id);
  if (!user) return;

  if (!tx.upsell) {
    await updateUserByChatId(tx.chat_id, { has_paid_main: true, stop_remarketing: true });
    await stopAllUserBumps(tx.chat_id);
    try {
      await sendToMeta('Purchase', { ...user, value: tx.amount, plan: tx.plan || user.plan || '', event_id: `purchase_${tx.tx_id}` });
      await markTransactionMetaSent(tx.tx_id);
    } catch (err) { console.log('PURCHASE META SEND FAILED:', err.message); }

    await safeSendMessage(tx.chat_id, `
✅ PAGAMENTO CONFIRMADO!

Seu acesso está sendo liberado...
`);
    await sendUpsellMessage(tx.chat_id);
  } else {
    await updateUserByChatId(tx.chat_id, { has_paid_upsell: true, stop_remarketing: true });
    await stopAllUserBumps(tx.chat_id);
    await safeSendMessage(tx.chat_id, `
🚀 ACESSO TOTAL LIBERADO!

Aproveite todo o conteúdo 🔥
`);
  }
}

// ================= RECONCILIAÇÃO AUTOMÁTICA =================
async function reconcilePendingPayments() {
  try {
    const pending = await getRecentPendingTransactions(30);
    for (const tx of pending) {
      if (!tx?.tx_id || reconcilingTxIds.has(tx.tx_id)) continue;
      reconcilingTxIds.add(tx.tx_id);
      try {
        const result = await getMPTransactionStatus(tx.tx_id);
        if (result.status === 'approved') {
          await confirmApprovedTransaction(tx, result.date_approved, 'reconcile_worker');
        }
      } catch (err) { console.log('RECONCILE TX ERROR:', tx.tx_id, err.message); }
      reconcilingTxIds.delete(tx.tx_id);
    }
  } catch (err) { console.log('RECONCILE WORKER ERROR:', err.message); }
}

// ================= TELEGRAM ERROR HELPERS =================
function getTelegramErrorCode(err) {
  return err?.response?.body?.error_code || err?.response?.statusCode || err?.response?.status || err?.code || null;
}

function getTelegramErrorDescription(err) {
  return String(err?.response?.body?.description || err?.response?.data?.description || err?.message || '').toLowerCase();
}

function isTelegramBlockedError(err) {
  const code = getTelegramErrorCode(err);
  const description = getTelegramErrorDescription(err);
  return code === 403 && (description.includes('bot was blocked') || description.includes('user is deactivated') || description.includes('chat not found'));
}

function logTelegramError(label, err) {
  if (isTelegramBlockedError(err)) {
    console.log(`${label} IGNORADO: usuário bloqueou o bot ou chat indisponível`);
    return;
  }
  console.log(`${label} ERROR:`, err?.response?.data || err?.response?.body || err?.message || err);
}

// ================= SAFE TELEGRAM SENDERS =================
async function safeSendMessage(chat_id, text, options = {}, label = 'SEND MESSAGE') {
  try { await bot.sendMessage(chat_id, text, options); return true; } 
  catch (err) { logTelegramError(label, err); return false; }
}

async function safeSendVideo(chat_id, fileId, options = {}, label = 'SEND VIDEO') {
  try { await bot.sendVideo(chat_id, fileId, options); return true; } 
  catch (err) { logTelegramError(label, err); return false; }
}

async function sendOptionalVideo(chat_id, fileId, label = 'OPTIONAL VIDEO') {
  if (!fileId) return false;
  return safeSendVideo(chat_id, fileId, {}, label);
}

// ================= UI MESSAGES (ORIGINAL COPY) =================
async function sendPlanMessage(chat_id) {
  const text = `
🔥 <b>BEM-VINDO AO VIP!</b>

Para liberar seu acesso agora mesmo, escolha um dos planos abaixo.

O acesso é enviado na hora após o pagamento! 😈
`;
  const keyboard = [
    [{ text: '💎 PLANO SEMANAL - R$ 7,42', callback_data: 'plan_week' }],
    [{ text: '🔥 PLANO VIP MENSAL - R$ 15,42', callback_data: 'plan_vip' }],
    [{ text: '👑 ACESSO VITALÍCIO - R$ 23,42', callback_data: 'plan_full' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, 'PLAN MESSAGE');
}

async function sendOrderBumpMessage(chat_id) {
  const text = `
🎁 <b>OFERTA ESPECIAL DE ÚLTIMA HORA!</b>

Amor, você quer adicionar o <b>Pack de Segurança + Conteúdo Extra</b> por apenas <b>R$ 4,99</b> adicionais?

Isso vai garantir que você nunca perca o acesso e ainda leva mídias exclusivas que não estão no plano comum.
`;
  const keyboard = [
    [{ text: '✅ SIM, EU QUERO ADICIONAR', callback_data: 'bump_yes' }],
    [{ text: '❌ NÃO, QUERO APENAS O PLANO', callback_data: 'bump_no' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, 'ORDER BUMP MESSAGE');
}

async function sendUpsellMessage(chat_id) {
  const text = `
🔥 <b>ESPERA! VOCÊ QUER LIBERAR O CONTEÚDO SECRETO?</b>

Muitos membros estão pedindo e eu liberei por tempo limitado.
Por apenas <b>R$ 10,00</b> você leva o pack de mídias mais pesadas do canal.

🟢 <b>Toque abaixo para liberar agora!</b>
`;
  const keyboard = [
    [{ text: '🟢 PAGAR TARIFA R$10', callback_data: 'upsell_buy' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }, 'UPSELL MESSAGE');
}

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

  await safeSendMessage(chat_id, introMessage, { parse_mode: 'HTML' }, 'CHECKOUT INTRO');
  await safeSendMessage(chat_id, 'Copie o código abaixo:', {}, 'CHECKOUT COPY LABEL');
  await safeSendMessage(chat_id, `<code>${escapeHtml(pixCode)}</code>`, { parse_mode: 'HTML' }, 'CHECKOUT PIX CODE');
  await safeSendMessage(chat_id, 'Estou segurando sua vaga por alguns minutos... ⏳', {}, 'CHECKOUT HOLD');

  const keyboard = [
    [{ text: '✅ Verificar Status', callback_data: `check_payment:${txId}` }],
    [{ text: '📋 Copiar Código', copy_text: { text: pixCode } }]
  ];
  await safeSendMessage(chat_id, 'Escolha uma opção abaixo:', { reply_markup: { inline_keyboard: keyboard } }, 'CHECKOUT ACTIONS');
}

async function goToPayment(chat_id, user, options = {}) {
  try {
    const amount = roundMoney(options.forcedAmount ?? user.value);
    const { txId, pixCode } = await createMPPix(user, amount, options);
    await createOrUpdateTransaction({
      tx_id: txId,
      chat_id,
      amount,
      upsell: !!options.isUpsell,
      downsell: !!options.isDownsell,
      pix_code: pixCode,
      plan: user.plan || '',
      status: 'pending',
      payment_method: 'pix'
    });
    await sendPixCheckoutMessage(chat_id, txId, amount, pixCode);
  } catch (err) {
    console.log('PAYMENT ERROR:', err.message);
    await safeSendMessage(chat_id, '❌ Erro ao gerar pagamento.', {}, 'PAYMENT ERROR MESSAGE');
  }
}

// ================= BUMP WORKER (ORIGINAL COPY) =================
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
        await safeSendMessage(bump.chat_id, `
${getScheduledBumpCopy(index)}

💳 Toque abaixo para gerar seu pagamento agora.
`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 GERAR PIX AGORA', callback_data: 'remarketing_pay_now' }],
              [{ text: '❌ NÃO QUERO', callback_data: 'remarketing_no' }]
            ]
          }
        }, `AUTO BUMP MESSAGE ${bump.bump_key}`);
        await markBumpSent(bump.id);
      } catch (err) { console.log('BUMP WORKER ITEM ERROR:', err.message); }
    }
  } catch (err) { console.log('BUMP WORKER ERROR:', err.message); }
}

// ================= TELEGRAM HANDLERS =================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;
    const startToken = (match?.[1] || '').trim();
    let payload = {};
    if (startToken) {
      const dbPayload = await consumeStartPayload(startToken);
      if (dbPayload) payload = dbPayload;
    }
    const user = {
      chat_id,
      ...payload,
      customer_name: payload.customer_name || DEFAULT_CUSTOMER_NAME,
      customer_email: payload.customer_email || `user${chat_id}@${DEFAULT_CUSTOMER_EMAIL_DOMAIN}`,
      customer_phone: onlyDigits(payload.customer_phone || DEFAULT_CUSTOMER_PHONE),
      customer_document: onlyDigits(payload.customer_document || DEFAULT_CUSTOMER_DOCUMENT),
      has_paid_main: false,
      has_paid_upsell: false,
      stop_remarketing: false
    };
    await upsertUser(user);
    await sendOptionalVideo(chat_id, VIDEO_START, 'START VIDEO');
    await sendToMeta('ViewContent', user);
    await sendPlanMessage(chat_id);
    await scheduleUserBumpsInDb(chat_id);
  } catch (err) { console.log('START ERROR:', err.message); }
});

bot.on('callback_query', async (query) => {
  try {
    const chat_id = query.message.chat.id;
    const data = query.data;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const user = await getUserByChatId(chat_id);
    if (!user) return;

    if (data === 'plan_week') {
      await updateUserByChatId(chat_id, { value: 7.42, plan: 'week' });
      await sendToMeta('InitiateCheckout', { ...user, value: 7.42, plan: 'week' });
      await sendOrderBumpMessage(chat_id);
    } else if (data === 'plan_vip') {
      await updateUserByChatId(chat_id, { value: 15.42, plan: 'vip' });
      await sendToMeta('InitiateCheckout', { ...user, value: 15.42, plan: 'vip' });
      await sendOrderBumpMessage(chat_id);
    } else if (data === 'plan_full') {
      await updateUserByChatId(chat_id, { value: 23.42, plan: 'full' });
      await sendToMeta('InitiateCheckout', { ...user, value: 23.42, plan: 'full' });
      await sendOrderBumpMessage(chat_id);
    } else if (data === 'bump_yes') {
      const newValue = roundMoney(Number(user.value || 0) + 4.99);
      await updateUserByChatId(chat_id, { value: newValue });
      await goToPayment(chat_id, { ...user, value: newValue });
    } else if (data === 'bump_no') {
      await goToPayment(chat_id, user);
    } else if (data === 'upsell_buy') {
      await goToPayment(chat_id, user, { isUpsell: true, forcedAmount: 10 });
    } else if (data === 'remarketing_pay_now') {
      await goToPayment(chat_id, user);
    } else if (data === 'remarketing_no') {
      await updateUserByChatId(chat_id, { stop_remarketing: true });
      await stopAllUserBumps(chat_id);
      await safeSendMessage(chat_id, 'Tudo bem.');
    } else if (data.startsWith('check_payment:')) {
      const txId = data.split(':')[1];
      const result = await getMPTransactionStatus(txId);
      if (result.status === 'approved') {
        await confirmApprovedTransaction({ tx_id: txId, chat_id }, result.date_approved, 'manual_check');
      } else {
        await safeSendMessage(chat_id, '⏳ Ainda não localizei a confirmação. Se você acabou de pagar, aguarde alguns segundos.');
      }
    }
  } catch (err) { console.log('CALLBACK ERROR:', err.message); }
});

// ================= ROUTES =================
app.post(TELEGRAM_PATH, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });

app.post(PAYMENT_PATH, async (req, res) => {
  try {
    const { action, data } = req.body;
    if (action === 'payment.updated' && data?.id) {
      const result = await getMPTransactionStatus(data.id);
      if (result.status === 'approved') {
        const tx = await getTransactionByTxId(String(data.id));
        if (tx) await confirmApprovedTransaction(tx, result.date_approved, 'webhook');
      }
    }
    res.sendStatus(200);
  } catch (err) { console.log('WEBHOOK ERROR:', err.message); res.sendStatus(200); }
});

app.get('/', (req, res) => res.status(200).send('BOT ONLINE'));

// ================= WORKERS & SERVER =================
setInterval(runScheduledBumps, 60 * 1000);
setInterval(reconcilePendingPayments, 60 * 1000);
setInterval(cleanupOldStartPayloads, 6 * 60 * 60 * 1000);

app.listen(PORT, async () => {
  console.log(`BOT ONLINE NA PORTA ${PORT}`);
  await bot.setWebHook(TELEGRAM_WEBHOOK_URL);
});
