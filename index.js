const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.RENDER_EXTERNAL_URL;

const SYNCPAY_URL = process.env.SYNCPAY_BASE_URL;
const CLIENT_ID = process.env.SYNCPAY_CLIENT_ID;
const CLIENT_SECRET = process.env.SYNCPAY_CLIENT_SECRET;

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_TOKEN = process.env.META_TOKEN;

const bot = new TelegramBot(TOKEN);
const app = express();
app.use(bodyParser.json());

const users = {};
const transactions = {};
let accessToken = null;

// ================= AUTH SYNCPAY =================
async function getToken(){
if(accessToken) return accessToken;

const res = await axios.post(`${SYNCPAY_URL}/api/partner/v1/auth-token`,{
client_id: CLIENT_ID,
client_secret: CLIENT_SECRET
});

accessToken = res.data.access_token;
setTimeout(()=> accessToken=null, 3500*1000);
return accessToken;
}

// ================= META =================
async function sendToMeta(event,user){
try{
await axios.post(`https://graph.facebook.com/v18.0/${META_PIXEL_ID}/events?access_token=${META_TOKEN}`,{
data:[{
event_name:event,
event_time:Math.floor(Date.now()/1000),
event_id:user.event_id,
action_source:"website",
user_data:{
client_user_agent:user.ua,
fbc:user.fbc,
fbp:user.fbp
},
custom_data:{
value:user.value||0,
currency:"BRL"
}
}]
});
}catch(e){}
}

// ================= START =================
bot.onText(/\/start(.*)/,async(msg,match)=>{

const chat_id=msg.chat.id;

let payload={};
try{
payload=JSON.parse(Buffer.from(match[1],'base64').toString());
}catch{}

users[chat_id]={
fbc:payload.fbc||'',
fbp:payload.fbp||'',
ua:payload.ua||'',
event_id:uuidv4(),
value:0
};

await sendToMeta("PageView",users[chat_id]);

bot.sendMessage(chat_id,"Escolha seu plano:",{
reply_markup:{
inline_keyboard:[
[{text:"VIP R$15.42",callback_data:"vip"}]
]
}
});

});

// ================= CALLBACK =================
bot.on("callback_query",async(q)=>{

const chat_id=q.message.chat.id;
const user=users[chat_id];

if(!user) return;

if(q.data==="vip"){
user.value=15.42;
await sendToMeta("InitiateCheckout",user);

return bot.sendMessage(chat_id,"Gerando PIX...");
}

});

// ================= PAGAMENTO =================
async function gerarPix(user){

const token=await getToken();

const res=await axios.post(`${SYNCPAY_URL}/api/partner/v1/cash-in`,{
amount:user.value
},{
headers:{Authorization:`Bearer ${token}`}
});

const tx=res.data.identifier;
const pix=res.data.pix_code;

transactions[tx]=user;

return pix;

}

// ================= WEBHOOK TELEGRAM =================
app.post('/telegram',(req,res)=>{
bot.processUpdate(req.body);
res.sendStatus(200);
});

// ================= WEBHOOK PAGAMENTO =================
app.post('/webhook',async(req,res)=>{

const data=req.body;
const tx=data?.data?.id || data.id;

if(transactions[tx]){
const user=transactions[tx];

await sendToMeta("Purchase",user);

bot.sendMessage(user.chat_id,"Pagamento confirmado!");
}

res.sendStatus(200);
});

// ================= START SERVER =================
app.listen(process.env.PORT||3000,async()=>{
await bot.setWebHook(`${BASE_URL}/telegram`);
console.log("BOT ONLINE");
});
