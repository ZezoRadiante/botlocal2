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

const bot = new TelegramBot(TOKEN, { webHook: true });
const app = express();
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf ? buf.toString('utf8') : ''; } }));

// ================= MEMORY STATE =================
const processedPayments = new Set();
const processedMetaEvents = new Set();
const actionLock = {};
const reconcilingTxIds = new Set();

// ================= HELPERS =================
function nowSec() { return Math.floor(Date.now() / 1000); }
function roundMoney(value) { return Number(Number(value || 0).toFixed(2)); }
function formatBRL(value) { return roundMoney(value).toFixed(2); }
function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function onlyDigits(value) { return String(value || '').replace(/\D/g, ''); }
function lockAction(key, ttlMs = 5000) { if (actionLock[key]) return false; actionLock[key] = true; setTimeout(() => delete actionLock[key], ttlMs); return true; }
function sha256(value) { return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex'); }
function buildFallbackCustomer(chat_id) {
  const domain = String(DEFAULT_CUSTOMER_EMAIL_DOMAIN || 'gmail.com').replace(/^@+/, '').trim();
  return {
    name: DEFAULT_CUSTOMER_NAME || 'Cliente Telegram',
    email: `user${chat_id}@${domain}`,
    phone_number: onlyDigits(DEFAULT_CUSTOMER_PHONE) || '11999999999',
    document: onlyDigits(DEFAULT_CUSTOMER_DOCUMENT) || '12345678901'
  };
}

// ================= SUPABASE DB OPS =================
async function upsertUser(user) { const { error } = await supabase.from('users').upsert(user, { onConflict: 'chat_id' }); if (error) throw error; }
async function getUserByChatId(chat_id) { const { data, error } = await supabase.from('users').select('*').eq('chat_id', chat_id).maybeSingle(); if (error) throw error; return data; }
async function updateUserByChatId(chat_id, updates) { const { error } = await supabase.from('users').update(updates).eq('chat_id', chat_id); if (error) throw error; }
async function createOrUpdateTransaction(tx) { const { error } = await supabase.from('transactions').upsert(tx, { onConflict: 'tx_id' }); if (error) throw error; }
async function getTransactionByTxId(txId) { const { data, error } = await supabase.from('transactions').select('*').eq('tx_id', txId).maybeSingle(); if (error) throw error; return data; }
async function markTransactionPaidDb(txId, paidAt) { const { error } = await supabase.from('transactions').update({ status: 'paid', paid_at: paidAt }).eq('tx_id', txId); if (error) throw error; }
async function markTransactionMetaSent(txId) { const { error } = await supabase.from('transactions').update({ meta_sent: true }).eq('tx_id', txId); if (error) throw error; }
async function getRecentPendingTransactions(minutes = 30) { const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString(); const { data, error } = await supabase.from('transactions').select('*').eq('status', 'pending').gte('created_at', cutoff); if (error) throw error; return data || []; }
async function createStartPayload(payload) { const token = crypto.randomBytes(24).toString('base64url'); const { error } = await supabase.from('start_payloads').insert({ token, payload, used: false }); if (error) throw error; return token; }
async function consumeStartPayload(token) { const { data, error } = await supabase.from('start_payloads').select('*').eq('token', token).maybeSingle(); if (error) throw error; if (!data) return null; if (!data.used) { await supabase.from('start_payloads').update({ used: true }).eq('token', token); } return data.payload || null; }
async function scheduleUserBumpsInDb(chat_id) { const now = Date.now(); const rows = ORDER_BUMP_SCHEDULES.map((item) => ({ chat_id, bump_key: item.key, run_at: new Date(now + item.delayMs).toISOString(), sent: false })); const { error } = await supabase.from('scheduled_bumps').upsert(rows, { onConflict: 'chat_id,bump_key' }); if (error) throw error; }
async function stopAllUserBumps(chat_id) { const { error } = await supabase.from('scheduled_bumps').update({ sent: true, sent_at: new Date().toISOString() }).eq('chat_id', chat_id).eq('sent', false); if (error) throw error; }
async function getDueBumps(limit = 50) { const { data, error } = await supabase.from('scheduled_bumps').select('*').eq('sent', false) .lte('run_at', new Date().toISOString()).limit(limit); if (error) throw error; return data || []; }
async function markBumpSent(id) { const { error } = await supabase.from('scheduled_bumps').update({ sent: true, sent_at: new Date().toISOString() }).eq('id', id); if (error) throw error; }

// ================= META =================
async function sendToMeta(event_name, user, overrideEventId = null) {
  const metaEventId = overrideEventId || user.event_id || uuidv4();
  const dedupeKey = `${event_name}:${metaEventId}`;
  if (processedMetaEvents.has(dedupeKey)) return;
  processedMetaEvents.add(dedupeKey);
  try {
    const userData = { client_ip_address: user.ip || '', client_user_agent: user.ua || '', fbc: user.fbc || '', fbp: user.fbp || '' };
    if (user.chat_id) userData.external_id = sha256(user.chat_id);
    if (user.customer_email) userData.em = sha256(user.customer_email);
    if (user.customer_phone) userData.ph = sha256(user.customer_phone);
    if (user.customer_document) userData.db = sha256(user.customer_document);
    const payload = { data: [{ event_name, event_time: nowSec(), event_id: metaEventId, action_source: 'website', user_data: userData, custom_data: { currency: 'BRL', value: roundMoney(user.value || 0), utm_source: user.utm_source || '', utm_medium: user.utm_medium || '', utm_campaign: user.utm_campaign || '', utm_content: user.utm_content || '', utm_term: user.utm_term || '', campaign_id: user.campaign_id || '', adset_id: user.adset_id || '', ad_id: user.ad_id || '', plan: user.plan || '' } }] };
    if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;
    await axios.post(`https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`, payload, { timeout: 15000 });
  } catch (err) { processedMetaEvents.delete(dedupeKey); console.log('META ERROR:', err.message); }
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
      identification: { type: 'CPF', number: onlyDigits(user.customer_document || fallback.document) }
    },
    notification_url: `${BASE_URL}/webhook`,
    external_reference: String(user.chat_id)
  };
  const response = await mpPayment.create({ body, requestOptions: { idempotencyKey: uuidv4() } });
  if (!response || !response.id) throw new Error(`Erro MP: ${JSON.stringify(response)}`);
  return { txId: String(response.id), pixCode: response.point_of_interaction.transaction_data.qr_code, qrCodeImage: response.point_of_interaction.transaction_data.qr_code_base64 };
}

async function getMPTransactionStatus(txId) { return await mpPayment.get({ id: txId }); }

// ================= CONFIRMAÇÃO CENTRAL =================
async function confirmApprovedTransaction(tx, paidAt = null, source = 'unknown') {
  const freshTx = await getTransactionByTxId(tx.tx_id);
  if (!freshTx || freshTx.status === 'paid') return;
  await markTransactionPaidDb(tx.tx_id, paidAt ? new Date(paidAt).toISOString() : new Date().toISOString());
  const user = await getUserByChatId(tx.chat_id);
  if (!user) return;
  if (!tx.upsell) {
    await updateUserByChatId(tx.chat_id, { has_paid_main: true, stop_remarketing: true });
    await stopAllUserBumps(tx.chat_id);
    try { await sendToMeta('Purchase', { ...user, value: tx.amount, plan: tx.plan || user.plan || '', event_id: `purchase_${tx.tx_id}` }); await markTransactionMetaSent(tx.tx_id); } catch (err) {}
    await safeSendMessage(tx.chat_id, `✅ PAGAMENTO CONFIRMADO!\n\nSeu acesso está sendo liberado...`);
    await sendUpsellMessage(chat_id);
  } else {
    await updateUserByChatId(tx.chat_id, { has_paid_upsell: true, stop_remarketing: true });
    await stopAllUserBumps(tx.chat_id);
    await safeSendMessage(tx.chat_id, `🚀 ACESSO TOTAL LIBERADO!\n\nAproveite todo o conteúdo 🔥`);
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
        if (result.status === 'approved') await confirmApprovedTransaction(tx, result.date_approved, 'reconcile_worker');
      } catch (err) {}
      reconcilingTxIds.delete(tx.tx_id);
    }
  } catch (err) {}
}

// ================= TELEGRAM SENDERS =================
async function safeSendMessage(chat_id, text, options = {}) {
  try { await bot.sendMessage(chat_id, text, options); return true; } 
  catch (err) { return false; }
}
async function safeSendVideo(chat_id, fileId, options = {}) {
  try { await bot.sendVideo(chat_id, fileId, options); return true; } 
  catch (err) { return false; }
}

// ================= UI MESSAGES (EXACT COPY) =================
async function sendPlanMessage(chat_id) {
  const text = `
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
`;
  const keyboard = [
    [{ text: '💎 PLANO SEMANAL - R$ 7,42', callback_data: 'plan_week' }],
    [{ text: '🔥 PLANO VIP MENSAL - R$ 15,42', callback_data: 'plan_vip' }],
    [{ text: '👑 ACESSO VITALÍCIO - R$ 23,42', callback_data: 'plan_full' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendOrderBumpMessage(chat_id) {
  const text = `
🚫 <b>LIVES BANIDAS 🔥</b>

😈 Não perca o acesso das Lives mais exclusivas do Brasil!

📁 SEPARADAS POR PASTAS
💎 CONTEÚDOS ATUALIZADOS DIARIAMENTE

🔥 <b>ADICIONE POR APENAS R$4,99</b>
`;
  const keyboard = [
    [{ text: '✅ SIM, EU QUERO ADICIONAR', callback_data: 'bump_yes' }],
    [{ text: '❌ NÃO, QUERO APENAS O PLANO', callback_data: 'bump_no' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendUpsellMessage(chat_id) {
  const text = `
Parabéns! Sua vaga no Grupo VIP do Telegram foi reservada com sucesso!

Para ativar seu acesso, é necessário confirmar o pagamento da taxa única de manutenção de apenas R$6,99

<b>Tarifa de Segurança R$6,99 - Verificação Obrigatória</b>

Nós, prezamos pela qualidade, segurança e privacidade dos nossos membros.
Por isso, ativamos a Tarifa de Verificação Legal (T.V.L.), um protocolo obrigatório de verificação.

🔒 <b>Tarifa de Segurança – Verificação Obrigatória</b>

O valor é simbólico, serve apenas como filtro de acesso seguro e ajuda a manter o grupo trazendo sempre conteúdos pra você!

⚠️ <b>Transparência total:</b>
Este é um grupo oficial e verificado — não é golpe!
A taxa existe apenas para manter o grupo ativo, seguro e sempre atualizado para todos os membros.

⚠️ <b>Atenção:</b>
Se você não concluir essa verificação agora, seu acesso será bloqueado permanentemente.
E não terá reembolso de nenhum valor pago, fique ciente disso.
`;
  const keyboard = [
    [{ text: '🟢 TARIFA/REEMBOLSÁVEL por R$ 7.01', callback_data: 'upsell_buy' }]
  ];
  await safeSendMessage(chat_id, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
}

async function sendPixCheckoutMessage(chat_id, txId, amount, pixCode) {
  const intro = `✅ <b>Como realizar o pagamento:</b>\n1. Copie o código abaixo\n2. Pague no app do seu banco via PIX Copia e Cola\n\n<b>Valor:</b> R$ ${formatBRL(amount)}`;
  await safeSendMessage(chat_id, intro, { parse_mode: 'HTML' });
  await safeSendMessage(chat_id, `<code>${escapeHtml(pixCode)}</code>`, { parse_mode: 'HTML' });
  const keyboard = [
    [{ text: '✅ Verificar Status', callback_data: `check_payment:${txId}` }],
    [{ text: '📋 Copiar Código', copy_text: { text: pixCode } }]
  ];
  await safeSendMessage(chat_id, 'Toque no botão após pagar:', { reply_markup: { inline_keyboard: keyboard } });
}

async function goToPayment(chat_id, user, options = {}) {
  try {
    const amount = roundMoney(options.forcedAmount ?? user.value);
    const { txId, pixCode } = await createMPPix(user, amount, options);
    await createOrUpdateTransaction({ tx_id: txId, chat_id, amount, upsell: !!options.isUpsell, downsell: !!options.isDownsell, pix_code: pixCode, plan: user.plan || '', status: 'pending', payment_method: 'pix' });
    await sendPixCheckoutMessage(chat_id, txId, amount, pixCode);
  } catch (err) { await safeSendMessage(chat_id, '❌ Erro ao gerar pagamento.'); }
}

// ================= BUMP WORKER =================
async function runScheduledBumps() {
  try {
    const bumps = await getDueBumps(50);
    for (const bump of bumps) {
      const user = await getUserByChatId(bump.chat_id);
      if (!user || user.has_paid_main || user.stop_remarketing) { await markBumpSent(bump.id); continue; }
      await safeSendMessage(bump.chat_id, `🔥 Seu acesso ainda não foi liberado! Não perca a promoção.`, {
        reply_markup: { inline_keyboard: [[{ text: '🔥 GERAR PIX AGORA', callback_data: 'remarketing_pay_now' }]] }
      });
      await markBumpSent(bump.id);
    }
  } catch (err) {}
}

// ================= TELEGRAM HANDLERS =================
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chat_id = msg.chat.id;
  const startToken = (match?.[1] || '').trim();
  let payload = {};
  if (startToken) payload = await consumeStartPayload(startToken) || {};
  const user = { chat_id, ...payload, customer_name: payload.customer_name || DEFAULT_CUSTOMER_NAME, customer_email: payload.customer_email || `user${chat_id}@${DEFAULT_CUSTOMER_EMAIL_DOMAIN}`, has_paid_main: false, has_paid_upsell: false, stop_remarketing: false };
  await upsertUser(user);
  await safeSendVideo(chat_id, VIDEO_START);
  await sendToMeta('ViewContent', user);
  await sendPlanMessage(chat_id);
  await scheduleUserBumpsInDb(chat_id);
});

bot.on('callback_query', async (query) => {
  const chat_id = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});
  const user = await getUserByChatId(chat_id);
  if (!user) return;
  if (data === 'plan_week') { await updateUserByChatId(chat_id, { value: 7.42, plan: 'week' }); await sendOrderBumpMessage(chat_id); }
  else if (data === 'plan_vip') { await updateUserByChatId(chat_id, { value: 15.42, plan: 'vip' }); await sendOrderBumpMessage(chat_id); }
  else if (data === 'plan_full') { await updateUserByChatId(chat_id, { value: 23.42, plan: 'full' }); await sendOrderBumpMessage(chat_id); }
  else if (data === 'bump_yes') { const val = roundMoney(user.value + 4.99); await updateUserByChatId(chat_id, { value: val }); await goToPayment(chat_id, { ...user, value: val }); }
  else if (data === 'bump_no') { await goToPayment(chat_id, user); }
  else if (data === 'upsell_buy') { await goToPayment(chat_id, user, { isUpsell: true, forcedAmount: 7.01 }); }
  else if (data === 'remarketing_pay_now') { await goToPayment(chat_id, user); }
  else if (data.startsWith('check_payment:')) {
    const txId = data.split(':')[1];
    const result = await getMPTransactionStatus(txId);
    if (result.status === 'approved') await confirmApprovedTransaction({ tx_id: txId, chat_id }, result.date_approved, 'manual_check');
    else await safeSendMessage(chat_id, '⏳ Pagamento ainda pendente.');
  }
});

app.post('/telegram', (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
app.post('/webhook', async (req, res) => {
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
  } catch (err) { res.sendStatus(200); }
});

setInterval(runScheduledBumps, 60 * 1000);
setInterval(reconcilePendingPayments, 60 * 1000);

app.listen(PORT, async () => {
  console.log(`BOT ONLINE NA PORTA ${PORT}`);
  await bot.setWebHook(`${BASE_URL}/telegram`);
});
