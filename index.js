const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');

const SYNCPAY_URL = (process.env.SYNCPAY_BASE_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SYNCPAY_CLIENT_ID;
const CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET;

const META_PIXEL_ID = '1505014021315132';
const META_TOKEN = process.env.META_TOKEN;
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ================= MEDIA =================
const VIDEO_START = 'BAACAgEAAxkBAANjaeE1lWS7RCCUF3G0cehARZeHIxoAArkGAAIqEglHTEGxhQwHcS87BA';
const VIDEO_BUMP = 'BAACAgEAAxkBAANlaeE1r7jftHF1Z1ZkDpTLWFFY1_cAAroGAAIqEglHsnlZ68ElDLU7BA';

// Estrutura pronta para futuro downsell
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
if (!SYNCPAY_URL) throw new Error('SYNCPAY_BASE_URL não configurado');
if (!CLIENT_ID) throw new Error('SYNCPAY_CLIENT_ID não configurado');
if (!CLIENT_SECRET) throw new Error('SYNCPAY_CLIENT_SECRET não configurado');
if (!META_TOKEN) throw new Error('META_TOKEN não configurado');
if (!SUPABASE_URL) throw new Error('SUPABASE_URL não configurado');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurado');

// ================= INIT =================
const TELEGRAM_PATH = '/telegram';
const PAYMENT_PATH = '/webhook';
const TELEGRAM_WEBHOOK_URL = `${BASE_URL}${TELEGRAM_PATH}`;

const bot = new TelegramBot(TOKEN, { webHook: true });
const app = express();
app.use(bodyParser.json());

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ================= MEMORY STATE LEVE =================
// Aqui fica só deduplicação e cache de token; o estado principal está no Supabase.
const processedPayments = new Set();
const actionLock = {};
const processedMetaEvents = new Set();

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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

// ================= SUPABASE HELPERS =================
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

async function markTransactionPaidDb(txId) {
  const { error } = await supabase
    .from('transactions')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('tx_id', txId);

  if (error) throw error;
}

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
    const payload = {
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
            fbp: user.fbp || '',
            external_id: user.chat_id ? sha256(user.chat_id) : undefined
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

// ================= COPY EXATA DO FUNIL =================
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
    'Assim que confirmar, eu te chamo aqui na hora!'
  ].join('\n');

  await bot.sendMessage(chat_id, introMessage, {
    parse_mode: 'HTML'
  });

  await bot.sendMessage(chat_id, 'Copie o código abaixo:');

  await bot.sendMessage(chat_id, `<code>${escapeHtml(pixCode)}</code>`, {
    parse_mode: 'HTML'
  });

  await bot.sendMessage(chat_id, 'Estou segurando sua vaga por 5 minutos... ⏳');

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

    const { txId, pixCode, raw } = await createSyncPayCashIn(amount);

    await createOrUpdateTransaction({
      txId,
      chat_id,
      amount,
      upsell: isUpsell,
      downsell: isDownsell,
      pixCode,
      plan: user.plan || '',
      status: 'pending'
    });

    console.log('SYNCPAY CASHIN OK:', raw);

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

// ================= TELEGRAM START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  try {
    const chat_id = msg.chat.id;
    const param = match?.[1]?.trim() || '';
    const payload = safeBase64JsonDecode(param);

    const user = {
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
      plan: '',
      value: 0,
      has_paid_main: false,
      has_paid_upsell: false,
      stop_remarketing: false
    };

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
      user.value = 7.42;
      user.plan = 'week';
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
      user.value = 15.42;
      user.plan = 'vip';
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
      user.value = 23.42;
      user.plan = 'full';
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

    const tx = await getTransactionByTxId(txId);
    if (!tx) {
      console.log('WEBHOOK TX NOT FOUND:', { txId, eventHeader, status, body });
      return res.sendStatus(200);
    }

    if (tx.status === 'paid') {
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
    await markTransactionPaidDb(txId);

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

// ================= BUMP LOOP =================
setInterval(runScheduledBumps, 60 * 1000);

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
