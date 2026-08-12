require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');
const express = require('express');
const db = require('./db');
const config = require('./config');

const { GAME_BOT_API_PORT, GAME_BOT_API_TOKEN } = process.env;

const SCREENSHOT_DIR = path.join(__dirname, '..', 'captcha-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

// ---------- очередь задач ----------
let busy = false;
const taskQueue = [];
function enqueue(task) {
  taskQueue.push(task);
  runQueue();
}
async function runQueue() {
  if (busy || taskQueue.length === 0) return;
  busy = true;
  const task = taskQueue.shift();
  try {
    await task();
  } catch (e) {
    console.error('Ошибка задачи из очереди:', e);
  } finally {
    busy = false;
    runQueue();
  }
}

// ---------- ждём, пока настройки не будут заданы через телеграм-бота ----------
let bot = null;

async function waitForConfigAndConnect() {
  if (!config.isReadyToConnect()) {
    console.log('Жду настройки подключения (mc_host / mc_username) через админ-бота: /setup ...');
    setTimeout(waitForConfigAndConnect, 5000);
    return;
  }
  connect();
}

function connect() {
  const cfg = config.getAll();
  console.log(`Подключаюсь к ${cfg.mc_host}:${cfg.mc_port} как ${cfg.mc_username} (${cfg.mc_auth})`);

  bot = mineflayer.createBot({
    host: cfg.mc_host,
    port: Number(cfg.mc_port) || 25565,
    username: cfg.mc_username,
    auth: cfg.mc_auth || 'microsoft',
  });

  bot.once('spawn', () => {
    console.log('Бот заспавнился.');
    mineflayerViewer(bot, { port: Number(cfg.viewer_port) || 3007, firstPerson: true });
    startAntiAfk();
  });

  bot.on('kicked', (reason) => console.log('Кикнут:', reason));
  bot.on('error', (err) => console.log('Ошибка соединения:', err));
  bot.on('end', () => {
    console.log('Соединение разорвано, переподключение через 10 сек...');
    setTimeout(connect, 10000);
  });

  attachCaptchaListener();
}

waitForConfigAndConnect();

// ---------- анти-афк ----------
function startAntiAfk() {
  setInterval(() => {
    if (!bot || !bot.entity) return;
    const actions = ['jump', 'turn', 'step'];
    const action = actions[Math.floor(Math.random() * actions.length)];
    if (action === 'jump') {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
    } else if (action === 'turn') {
      bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch, true);
    } else {
      bot.setControlState('forward', true);
      setTimeout(() => {
        bot.setControlState('forward', false);
        bot.setControlState('back', true);
        setTimeout(() => bot.setControlState('back', false), 300);
      }, 300);
    }
  }, 50 * 1000);
}

// ---------- капча: детект + скриншот вьювера через puppeteer ----------
// ЗАГЛУШКА: под конкретный формат капчи Фантайм regex/событие нужно поправить самому.
const CAPTCHA_REGEX = /капч|введите код|подтвердите/i;
let captchaPending = false;

function attachCaptchaListener() {
  bot.on('message', async (jsonMsg) => {
    const text = jsonMsg.toString();
    if (CAPTCHA_REGEX.test(text) && !captchaPending) {
      captchaPending = true;
      console.log('Похоже на капчу:', text);
      const row = db.prepare(`INSERT INTO captcha_requests (status) VALUES ('waiting')`).run();
      const requestId = row.lastInsertRowid;

      let imagePath = null;
      try {
        imagePath = await takeViewerScreenshot(requestId);
        db.prepare(`UPDATE captcha_requests SET image_path = ? WHERE id = ?`).run(imagePath, requestId);
      } catch (e) {
        console.error('Не удалось сделать скриншот капчи:', e.message);
      }

      waitForCaptchaAnswer(requestId);
    }
  });
}

async function takeViewerScreenshot(requestId) {
  const puppeteer = require('puppeteer-core');
  const cfg = config.getAll();
  const chromePath = process.env.CHROME_PATH || '/usr/bin/chromium-browser';

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(`http://localhost:${cfg.viewer_port || 3007}`, { waitUntil: 'networkidle0', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500)); // дать вьюверу дорендерить кадр

  const filePath = path.join(SCREENSHOT_DIR, `captcha_${requestId}.png`);
  await page.screenshot({ path: filePath });
  await browser.close();
  return filePath;
}

function waitForCaptchaAnswer(requestId) {
  const interval = setInterval(() => {
    const row = db.prepare(`SELECT * FROM captcha_requests WHERE id = ?`).get(requestId);
    if (row && row.status === 'answered' && row.answer) {
      clearInterval(interval);
      bot.chat(row.answer);
      captchaPending = false;
      console.log(`Капча #${requestId} отправлена в чат: ${row.answer}`);
    }
  }, 2000);
}

// ---------- ДЕПОЗИТ: координаты берутся из конфига (задаются через /setup) ----------
async function processDeposit(depositId) {
  const deposit = db.prepare(`SELECT * FROM deposits WHERE id = ?`).get(depositId);
  if (!deposit) return;

  db.prepare(`UPDATE deposits SET status = 'processing' WHERE id = ?`).run(depositId);

  try {
    const count = deposit.spheres_count;
    const cfg = config.getAll();
    const chestCoord = config.getCoord('coord_chest');
    const anvilCoord = config.getCoord('coord_anvil');
    const shulkerCoord = config.getCoord('coord_shulker');

    const chestBlock = bot.blockAt(chestCoord);
    const chestWindow = await bot.openContainer(chestBlock);
    const sphereItem = chestWindow.containerItems().find(i => i.name.includes(cfg.sphere_item_name));
    if (!sphereItem) throw new Error('Сферы закончились на складе — нужно пополнить вручную');
    await bot.withdraw(sphereItem.type, null, count);
    await chestWindow.close();

    const anvilBlockRef = bot.blockAt(anvilCoord);
    const anvilWindow = await bot.openAnvil(anvilBlockRef);
    await anvilWindow.rename(deposit.mc_nickname);
    await bot.closeWindow(anvilWindow);

    const shulkerBlockRef = bot.blockAt(shulkerCoord);
    const shulkerWindow = await bot.openContainer(shulkerBlockRef);
    const renamedStack = bot.inventory.items().find(i => i.name.includes(cfg.sphere_item_name));
    await bot.deposit(shulkerWindow, renamedStack.type, null, count);
    await shulkerWindow.close();

    db.prepare(`UPDATE deposits SET status = 'done', completed_at = datetime('now') WHERE id = ?`).run(depositId);
    console.log(`Депозит #${depositId} выполнен: ${count} сфер для ${deposit.mc_nickname}`);
  } catch (e) {
    db.prepare(`UPDATE deposits SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message || e), depositId);
    console.error(`Депозит #${depositId} провалился:`, e);
  }
}

// ---------- ВЫВОД: /ah search ник -> проверка цены -> покупка ----------
async function ahSearch(nickname) {
  bot.chat(`/ah search ${nickname}`);
  return new Promise((resolve) => {
    const onWindowOpen = (window) => {
      const lots = [];
      for (const slot of window.slots) {
        if (!slot) continue;
        const lore = getLore(slot);
        const seller = extractSellerFromLore(lore);
        const price = extractPriceFromLore(lore);
        if (seller && price) lots.push({ slot: slot.slot, seller, price });
      }
      bot.removeListener('windowOpen', onWindowOpen);
      resolve({ window, lots });
    };
    bot.once('windowOpen', onWindowOpen);
  });
}

function getLore(item) {
  try {
    return item.nbt?.value?.display?.value?.Lore?.value?.value || [];
  } catch {
    return [];
  }
}
function extractSellerFromLore(loreLines) {
  const line = loreLines.find(l => /продавец|seller/i.test(l));
  if (!line) return null;
  const match = line.match(/:\s*(\S+)/);
  return match ? match[1].replace(/§./g, '') : null;
}
function extractPriceFromLore(loreLines) {
  const line = loreLines.find(l => /цена|price/i.test(l));
  if (!line) return null;
  const digits = line.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

async function processWithdrawal(withdrawalId) {
  const w = db.prepare(`SELECT * FROM withdrawals WHERE id = ?`).get(withdrawalId);
  if (!w) return;

  db.prepare(`UPDATE withdrawals SET status = 'processing' WHERE id = ?`).run(withdrawalId);

  try {
    const { window, lots } = await ahSearch(w.mc_nickname);
    const lot = lots.find(l => l.seller.toLowerCase() === w.mc_nickname.toLowerCase());

    if (!lot) throw new Error(`Лот от ${w.mc_nickname} не найден на аукционе`);
    if (lot.price !== w.expected_price) {
      throw new Error(`Цена не совпадает: ожидалось ${w.expected_price}, в лоте ${lot.price}`);
    }

    await bot.clickWindow(lot.slot, 0, 0);
    await bot.closeWindow(window);

    db.prepare(`UPDATE withdrawals SET status = 'done', completed_at = datetime('now') WHERE id = ?`).run(withdrawalId);
    console.log(`Вывод #${withdrawalId} выполнен: куплен лот ${w.mc_nickname} за ${lot.price}`);
  } catch (e) {
    db.prepare(`UPDATE withdrawals SET status = 'failed', error = ? WHERE id = ?`).run(String(e.message || e), withdrawalId);
    console.error(`Вывод #${withdrawalId} провалился:`, e);
  }
}

// ---------- локальное HTTP API для admin-бота ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-api-token'] !== GAME_BOT_API_TOKEN) return res.sendStatus(403);
  next();
});

app.post('/deposit/:id', (req, res) => {
  enqueue(() => processDeposit(Number(req.params.id)));
  res.json({ queued: true });
});

app.post('/withdraw/:id', (req, res) => {
  enqueue(() => processWithdrawal(Number(req.params.id)));
  res.json({ queued: true });
});

app.post('/ah/sell', async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'bot not connected' });
  const { price } = req.body;
  bot.chat(`/ah sell ${price}`);
  res.json({ sent: true });
});

app.post('/ah/search', async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'bot not connected' });
  const { nickname } = req.body;
  const { lots } = await ahSearch(nickname);
  res.json({ lots });
});

app.get('/captcha/image/:id', (req, res) => {
  const row = db.prepare(`SELECT image_path FROM captcha_requests WHERE id = ?`).get(req.params.id);
  if (!row || !row.image_path || !fs.existsSync(row.image_path)) return res.sendStatus(404);
  res.sendFile(row.image_path);
});

app.post('/captcha/answer/:id', (req, res) => {
  const { answer } = req.body;
  db.prepare(`UPDATE captcha_requests SET status='answered', answer=? WHERE id=?`).run(answer, req.params.id);
  res.json({ ok: true });
});

app.get('/status', (req, res) => {
  res.json({ connected: Boolean(bot && bot.entity), config: config.getAll() });
});

app.listen(Number(GAME_BOT_API_PORT) || 4000, () =>
  console.log(`Локальное API игрового бота слушает порт ${GAME_BOT_API_PORT || 4000}`)
);
