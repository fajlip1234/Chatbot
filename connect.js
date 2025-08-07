const axios = require('axios');
const puppeteer = require('puppeteer');
const fs = require('fs');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function logDebug(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

async function launchAdsPowerProfile(adsPowerId) {
  logDebug(`🚀 Starting AdsPower profile: ${adsPowerId}`);
  const res = await axios.get(`http://localhost:50325/api/v1/browser/start?user_id=${adsPowerId}`);

  if (res.data.code !== 0) {
    throw new Error(`❌ Failed to start AdsPower profile: ${res.data.msg}`);
  }

  const ws = res.data.data.ws.puppeteer;
  logDebug(`✅ AdsPower profile started. WebSocket: ${ws}`);
  return ws;
}

async function readLatestDM(ws) {
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });
  const pages = await browser.pages();
  const page = pages[0];

  // ✅ Close extra tabs
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close();
  }

  await page.setViewport({ width: 1280, height: 800 });

  logDebug(`🌐 Navigating to Twitter DMs...`);
  await page.goto('https://twitter.com/messages', { waitUntil: 'domcontentloaded' });
  await wait(3000);

  await page.screenshot({ path: 'debug-dm-page.png' });
  logDebug(`📸 Screenshot saved as debug-dm-page.png`);

  try {
    await page.waitForSelector('[data-testid="conversation"]', { timeout: 20000 });
    const conversations = await page.$$('div[data-testid="conversation"]');

    if (conversations.length === 0) {
      logDebug(`📭 No conversations found.`);
    } else {
      logDebug(`📨 Found ${conversations.length} conversations. Opening first...`);
      await conversations[0].click();
      await wait(3000);

      // ✅ New safe selector for message content
      const messageBubbles = await page.$$('div[dir="auto"]');
      const lastBubble = messageBubbles[messageBubbles.length - 1];

      const text = await page.evaluate(el => el.innerText, lastBubble);
      logDebug(`💬 Latest message: ${text}`);
    }
  } catch (e) {
    logDebug(`❌ Could not extract message text. Layout may have changed.`);
  }

  await browser.disconnect();
  logDebug(`🔌 Browser disconnected.`);
}

(async () => {
  const mapping = require('./mapping.json');
  const profile = mapping[0];

  try {
    const ws = await launchAdsPowerProfile(profile.adsPowerId);
    await readLatestDM(ws);
  } catch (err) {
    logDebug(`❌ Script error: ${err.message}`);
  }
})();
