// ================= START =================
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chat_id = msg.chat.id;

  let payload = {};

  try {
    const param = match[1]?.trim();

    if (param) {
      payload = JSON.parse(
        Buffer.from(param, "base64").toString()
      );
    }
  } catch (e) {
    console.log("Erro ao decodificar payload:", e.message);
  }

  const event_id = uuidv4();

  users[chat_id] = {
    fbc: payload.fbc || "",
    fbp: payload.fbp || "",
    ip: payload.ip || "",
    ua: payload.ua || "",
    event_id
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
