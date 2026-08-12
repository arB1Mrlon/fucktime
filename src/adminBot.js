require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const config = require('./config');

const { ADMIN_BOT_TOKEN, ADMIN_WHITELIST, GAME_BOT_API_PORT, GAME_BOT_API_TOKEN } = process.env;

const whitelist = new Set((ADMIN_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean));
const bot = new TelegramBot(ADMIN_BOT_TOKEN, { polling: true });
const GAME_API = `http://127.0.0.1:${GAME_BOT_API_PORT || 4000}`;

function isAllowed(msg) {
  return whitelist.has(String(msg.from.id));
}
function deny(chatId) {
  bot.sendMessage(chatId, 'У тебя нет доступа к этому боту.');
}
async function callGameApi(path, body, method = 'POST') {
  const res = await fetch(`${GAME_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-token': GAME_BOT_API_TOKEN },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  return res.json();
}

// =====================================================================
// НАСТРОЙКА ЧЕРЕЗ ТЕЛЕГРАМ — команды /setup, конфиг хранится в БД,
// после смены mc_host/mc_port/mc_username/mc_auth нужен pm2 restart mc-game-bot,
// координаты и цена сферы подхватываются на лету, без рестарта.
// =====================================================================

bot.onText(/^\/setup$/, (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    'Доступные команды настройки:\n\n' +
    '/setup host <адрес сервера>\n' +
    '/setup port <порт>\n' +
    '/setup username <ник аккаунта бота>\n' +
    '/setup auth <microsoft|offline>\n' +
    '/setup sphere_price <число>\n' +
    '/setup coord chest <x> <y> <z>\n' +
    '/setup coord anvil <x> <y> <z>\n' +
    '/setup coord shulker <x> <y> <z>\n\n' +
    'Посмотреть текущие настройки: /config\n' +
    '⚠️ После смены host/port/username/auth нужно перезапустить игрового бота: /restart_game'
  );
});

bot.onText(/^\/setup host (\S+)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  config.set('mc_host', m[1]);
  bot.sendMessage(msg.chat.id, `Хост установлен: ${m[1]}\nНе забудь /restart_game`);
});

bot.onText(/^\/setup port (\d+)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  config.set('mc_port', m[1]);
  bot.sendMessage(msg.chat.id, `Порт установлен: ${m[1]}\nНе забудь /restart_game`);
});

bot.onText(/^\/setup username (\S+)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  config.set('mc_username', m[1]);
  bot.sendMessage(msg.chat.id, `Игровой аккаунт установлен: ${m[1]}\nНе забудь /restart_game`);
});

bot.onText(/^\/setup auth (microsoft|offline)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  config.set('mc_auth', m[1]);
  bot.sendMessage(msg.chat.id, `Тип авторизации установлен: ${m[1]}\nНе забудь /restart_game`);
});

bot.onText(/^\/setup sphere_price (\d+)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  config.set('sphere_price', m[1]);
  bot.sendMessage(msg.chat.id, `Цена сферы установлена: ${m[1]} за штуку.`);
});

bot.onText(/^\/setup coord (chest|anvil|shulker) (-?\d+) (-?\d+) (-?\d+)$/, (msg, m) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const [, name, x, y, z] = m;
  config.set(`coord_${name}`, `${x},${y},${z}`);
  bot.sendMessage(msg.chat.id, `Координаты "${name}" установлены: ${x} ${y} ${z}`);
});

bot.onText(/^\/config$/, (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const cfg = config.getAll();
  const text = Object.entries(cfg).map(([k, v]) => `${k}: ${v}`).join('\n');
  bot.sendMessage(msg.chat.id, `Текущие настройки:\n\n${text}`);
});

bot.onText(/^\/restart_game$/, (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    'Сам телеграм-бот не может перезапускать другой процесс без доступа к shell.\n' +
    'Выполни на сервере: pm2 restart mc-game-bot'
  );
});

// =====================================================================
// АУКЦИОН
// =====================================================================

bot.onText(/\/ah sell (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const price = Number(match[1]);
  const r = await callGameApi('/ah/sell', { price });
  if (r.error) return bot.sendMessage(msg.chat.id, `Ошибка: ${r.error}`);
  bot.sendMessage(msg.chat.id, `Выставил лот с ценой ${price}`);
});

bot.onText(/\/ah search (\S+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const nickname = match[1];
  const result = await callGameApi('/ah/search', { nickname });
  if (result.error) return bot.sendMessage(msg.chat.id, `Ошибка: ${result.error}`);
  if (!result.lots || result.lots.length === 0) {
    return bot.sendMessage(msg.chat.id, `Лотов от ${nickname} не найдено.`);
  }
  const text = result.lots.map(l => `слот ${l.slot} — продавец: ${l.seller}, цена: ${l.price}`).join('\n');
  bot.sendMessage(msg.chat.id, text);
});

// =====================================================================
// КАПЧА КАРТИНКОЙ: отвечать на фото командой в реплае: /captcha_ok <id> <текст>
// =====================================================================

bot.onText(/\/captcha_ok (\d+) (.+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const [, id, answer] = match;
  await callGameApi(`/captcha/answer/${id}`, { answer });
  bot.sendMessage(msg.chat.id, `Ответ на капчу #${id} отправлен в игру.`);
});

const notifiedCaptchas = new Set();
setInterval(async () => {
  const waiting = db.prepare(`SELECT * FROM captcha_requests WHERE status='waiting'`).all();
  for (const req of waiting) {
    if (notifiedCaptchas.has(req.id)) continue;
    // ждём картинку максимум ~10 сек, иначе шлём текстовым алертом
    if (!req.image_path) continue;
    notifiedCaptchas.add(req.id);
    for (const adminId of whitelist) {
      try {
        const imgRes = await fetch(`${GAME_API}/captcha/image/${req.id}`, {
          headers: { 'x-api-token': GAME_BOT_API_TOKEN },
        });
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        await bot.sendPhoto(adminId, buffer, {
          caption: `⚠️ Капча #${req.id}. Ответь: /captcha_ok ${req.id} <текст с картинки>`,
        }, { filename: `captcha_${req.id}.png`, contentType: 'image/png' });
      } catch (e) {
        bot.sendMessage(
          adminId,
          `⚠️ Капча #${req.id} (не удалось прикрепить картинку: ${e.message}).\n` +
          `Ответь: /captcha_ok ${req.id} <текст>`
        );
      }
    }
  }
  // если запрос без картинки висит больше 10 сек — всё равно предупредить текстом
  const now = Date.now();
  for (const req of waiting) {
    if (notifiedCaptchas.has(req.id)) continue;
    const age = now - new Date(req.created_at + 'Z').getTime();
    if (age > 10000) {
      notifiedCaptchas.add(req.id);
      for (const adminId of whitelist) {
        bot.sendMessage(adminId, `⚠️ Капча #${req.id} без картинки. Ответь: /captcha_ok ${req.id} <текст>`);
      }
    }
  }
}, 3000);

// =====================================================================
// ЗАЯВКИ И СТАТИСТИКА
// =====================================================================

bot.onText(/\/deposit_run (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await callGameApi(`/deposit/${match[1]}`);
  bot.sendMessage(msg.chat.id, `Депозит #${match[1]} поставлен в очередь.`);
});

bot.onText(/\/withdraw_run (\d+)/, async (msg, match) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  await callGameApi(`/withdraw/${match[1]}`);
  bot.sendMessage(msg.chat.id, `Вывод #${match[1]} поставлен в очередь.`);
});

bot.onText(/\/stats/, (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  const pendingDeposits = db.prepare(`SELECT COUNT(*) c FROM deposits WHERE status='pending'`).get().c;
  const pendingWithdrawals = db.prepare(`SELECT COUNT(*) c FROM withdrawals WHERE status='pending'`).get().c;
  const failedToday = db.prepare(`SELECT COUNT(*) c FROM deposits WHERE status='failed' AND date(created_at)=date('now')`).get().c;
  bot.sendMessage(msg.chat.id,
    `Ожидают депозита: ${pendingDeposits}\nОжидают вывода: ${pendingWithdrawals}\nПровалились сегодня: ${failedToday}`
  );
});

bot.onText(/\/status/, async (msg) => {
  if (!isAllowed(msg)) return deny(msg.chat.id);
  try {
    const r = await callGameApi('/status', null, 'GET');
    bot.sendMessage(msg.chat.id, r.connected ? '✅ Бот подключён к серверу' : '❌ Бот не подключён');
  } catch {
    bot.sendMessage(msg.chat.id, '❌ Игровой бот недоступен (процесс не запущен?)');
  }
});

// ---------- автозапуск новых pending-депозитов/выводов ----------
setInterval(async () => {
  const deposits = db.prepare(`SELECT id FROM deposits WHERE status='pending'`).all();
  for (const d of deposits) await callGameApi(`/deposit/${d.id}`).catch(() => {});
  const withdrawals = db.prepare(`SELECT id FROM withdrawals WHERE status='pending'`).all();
  for (const w of withdrawals) await callGameApi(`/withdraw/${w.id}`).catch(() => {});
}, 10000);

console.log('Admin-бот запущен.');
