const fs = require('fs');
const path = require('path');
const axios = require('axios');
const puppeteer = require('puppeteer-core');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nowISO() { return new Date().toISOString(); }
function die(msg) { console.error(msg); process.exit(1); }

if (!fs.existsSync('./config.json')) die('Missing config.json');
const CONFIG = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

const PROFILE_ID = CONFIG.profileId;
const API_BASE = `http://${CONFIG.apiHost}:${CONFIG.apiPort}`;

const PRE_INBOX_WAIT_MS = Number(CONFIG.preInboxWaitMs ?? 2500);
const INBOX_POST_GOTO_WAIT_MS = Number(CONFIG.inboxPostGotoWaitMs ?? 2000);
const TARGET_NAME = String((CONFIG.dm && CONFIG.dm.targetName) ?? '').trim();
const SHOT_DIR = (CONFIG.dm && CONFIG.dm.screenshotDir) || './dm-shots';
const EXPORT_DIR = (CONFIG.dm && CONFIG.dm.exportDir) || './exports';
const TAKE_SHOT = !!((CONFIG.dm && CONFIG.dm.screenshot) ?? true);

// ---- AdsPower helpers ----
async function startProfile(userId) {
  console.log(`[ADSPower] Starting profile: ${userId}`);
  const { data } = await axios.get(`${API_BASE}/api/v1/browser/start`, {
    params: { user_id: userId, headless: CONFIG.headless ? 1 : 0 }
  });
  if (data.code !== 0) throw new Error(`Start failed: ${data.msg || JSON.stringify(data)}`);
  return data.data;
}

async function stopProfile(userId) {
  console.log(`[ADSPower] Stopping profile: ${userId}`);
  try {
    await axios.get(`${API_BASE}/api/v1/browser/stop`, { params: { user_id: userId } });
  }
  catch (e) { console.warn('Stop warning:', e?.response?.data || e.message); }
}

async function connectPuppeteer(startData) {
  let wsEndpoint = null;
  if (typeof startData.ws === 'string') wsEndpoint = startData.ws;
  else if (startData.ws && typeof startData.ws.puppeteer === 'string') wsEndpoint = startData.ws.puppeteer;
  if (!wsEndpoint) throw new Error(`No valid Puppeteer WS endpoint in startData: ${JSON.stringify(startData)}`);
  return puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
    defaultViewport: null,
    protocolTimeout: 180_000
  });
}

// ---- IG navigation ----
async function openInbox(page) {
  console.log('[NAV] Opening instagram HOME');
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
  await sleep(PRE_INBOX_WAIT_MS);

  console.log('[NAV] Going to /direct/inbox');
  await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'domcontentloaded' });
  await sleep(INBOX_POST_GOTO_WAIT_MS);
}

// ---- Click the "one box" row by label (robust) ----
async function clickThreadByRowButton(page, label, maxScrolls = 22) {
  const L = label.toLowerCase();
  for (let i = 0; i < maxScrolls; i++) {
    const hit = await page.evaluate((L) => {
      function isVis(el) {
        const s = getComputedStyle(el); const r = el.getBoundingClientRect();
        return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
      }

      const rows = Array.from(document.querySelectorAll('div[role="button"][tabindex="0"]'));
      let best = null, score = 0;
      for (const r of rows) {
        if (!isVis(r)) continue;
        const t = (r.innerText || r.textContent || '').trim().toLowerCase();
        if (!t || !t.includes(L)) continue;
        const sc = (t === L) ? 3 : (t.startsWith(L) ? 2 : 1);
        if (sc > score) { score = sc; best = r; }
      }
      if (!best) return null;
      const rect = best.getBoundingClientRect();
      try { best.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
      try { best.click(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, dom: true }; }
      catch { return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, dom: false }; }
    }, L);

    if (hit) {
      if (!hit.dom) {
        await page.mouse.click(hit.x, hit.y);
        try { await page.touchscreen.tap(hit.x, hit.y); } catch {}
      }
      // wait to confirm thread view
      const opened = await ensureThread(page, 8000);
      if (opened) return true;
    }

    // scroll to reveal more rows
    await page.evaluate(() => {
      function isScrollable(el) {
        const s = getComputedStyle(el);
        return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      }
      const cands = Array.from(document.querySelectorAll('main *')).filter(isScrollable);
      if (cands.length) {
        let best = cands[0];
        for (const c of cands) if (c.scrollHeight > best.scrollHeight) best = c;
        best.scrollBy(0, Math.round(best.clientHeight * 0.9));
      } else {
        (document.scrollingElement || document.documentElement)
          .scrollBy(0, Math.round(window.innerHeight * 0.9));
      }
    });
    await sleep(420);
  }
  return false;
}

async function ensureThread(page, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate(() => {
      const hasInput = !!document.querySelector('[contenteditable="true"]');
      const inUrl = location.pathname.includes('/direct/t/');
      return hasInput || inUrl;
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

// ---- Thread container + export ----
async function getThreadContainerHandle(page) {
  try { await page.waitForSelector('[contenteditable="true"]', { timeout: 12000 }); } catch {}
  const handle = await page.evaluateHandle(() => {
    function isScrollable(el) {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    }
    function looksLikeThread(el) {
      return !!el.querySelector('time, [role="row"], [data-visualcompletion], [dir="auto"]');
    }
    const selectorGroups = [
      'div[role="main"] div[role="grid"]',
      'div[role="dialog"] div[role="grid"]',
      'div[role="main"] [style*="overflow"]',
      'main [style*="overflow"]',
      '[style*="overflow-y"]'
    ];
    for (const sel of selectorGroups) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        if (isScrollable(el) && looksLikeThread(el)) return el;
      }
    }
    const cands = Array.from(document.querySelectorAll('main *')).filter(isScrollable);
    if (cands.length) {
      cands.sort((a, b) => (b.scrollHeight - a.scrollHeight));
      return cands[0];
    }
    return document.scrollingElement || document.documentElement;
  });
  const el = await handle.asElement();
  if (!el) { try { await handle.dispose(); } catch {} }
  return el;
}

async function scrollThreadToOldest(page, containerEl, maxRounds = 160) {
  for (let round = 0; round < maxRounds; round++) {
    const { atTop, clickedOlder } = await page.evaluate(async (el) => {
      function clickOlderButtons() {
        let clicked = false;
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a[role="link"]'));
        for (const b of btns) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').toLowerCase();
          if (!t) continue;
          if (t.includes('older') || t.includes('load more') || t.includes('more messages') ||
            t.includes('staršie') || t.includes('zobraziť ďalšie') || t.includes('zobraziť viac')) {
            b.click(); clicked = true;
          }
        }
        return clicked;
      }
      const before = el.scrollTop;
      el.scrollTop = 0;
      const clickedOlder = clickOlderButtons();
      return await new Promise((resolve) => {
        setTimeout(() => {
          const now = el.scrollTop;
          const atTop = (now === 0 && before === 0);
          resolve({ atTop, clickedOlder });
        }, 900);
      });
    }, containerEl);
    await sleep(980);
    if (atTop && !clickedOlder) { await sleep(1200); break; }
  }
}

async function focusOnInboxTab(browser) {
  const pages = await browser.pages();
  let targetPage = null;

  // Loop through all open pages and find the one with the Instagram inbox URL
  for (const page of pages) {
    const url = await page.url();
    if (url.includes('https://www.instagram.com/direct/inbox/')) {
      targetPage = page;
      break;
    }
  }

  if (!targetPage) {
    throw new Error('Inbox tab not found!');
  }

  console.log('Switching to the Inbox tab...');
  await targetPage.bringToFront();  // Brings the tab to the foreground
  return targetPage;
}

async function exportFullThread(page, exportDir) {
  // Focus on the correct inbox tab before exporting
  const focusedPage = await focusOnInboxTab(page.browser());

  // Wait for thread container
  const container = await getThreadContainerHandle(focusedPage);
  if (!container) throw new Error('Could not locate DM thread container.');

  // Increase the wait time before scraping to ensure the thread loads completely
  console.log('[WAIT] Waiting for thread to load...');
  await sleep(8000);  // Increased wait time to 8 seconds

  const threadContent = await focusedPage.evaluate((el) => {
    const messages = [];
    // Select all message containers that contain actual message content
    const messageElements = el.querySelectorAll('div[role="button"][tabindex="0"]:not([aria-disabled="true"])');

    messageElements.forEach((msg) => {
      // Extract sender name from the <span> element containing the name
      const senderElement = msg.querySelector('span.x1lliihq span');
      const sender = senderElement ? senderElement.innerText.trim() : "Unknown";

      // Get message content from the div with the class 'html-div' (messages)
      const messageElement = msg.querySelector('div.html-div');
      let message = messageElement ? messageElement.innerText.trim().replace(/\n/g, ' ') : "";

      // Filter out unwanted message content (e.g., navigation buttons, timestamps, profile info)
      const unwantedMessages = [
        "Späť", // Back button or navigation elements
        "miklos4410Ikona", // Profile info or non-message content
        "Filip KristanHalo", // Profile or timestamp-related content
        "Zobraziť profil", // Profile links
        "Instagram", // Profile or app-specific content
        "Send", // Buttons for sending messages
        "Po", // Timestamps like "Po 11:23"
        "·", // Timestamps or profile info
        "Zmrde" // Ignore non-message content, adjust if needed
      ];

      if (unwantedMessages.some((unwanted) => message.includes(unwanted))) {
        return;  // Skip these types of messages
      }

      // Only add the message if it's not empty
      if (message) {
        messages.push({
          sender,
          message
        });
      }
    });

    return messages;
  }, container); // This evaluates inside the browser's page context

  // Save the data to a JSON file
  const data = {
    threadContent
  };

  fs.mkdirSync(exportDir, { recursive: true });
  const ts = nowISO().replace(/[:.]/g, '-');
  const outJson = path.join(exportDir, `dm-thread-full-${ts}.json`);

  fs.writeFileSync(outJson, JSON.stringify(data, null, 2), 'utf-8');
  console.log('[EXPORT]', outJson, `(${threadContent.length} messages)`);
  return { outJson };
}











// Function to wait for the thread content to load fully
async function waitForThreadContent(page, containerEl, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate((el) => {
      const messagesLoaded = el.querySelectorAll('div[data-visualcompletion="ignore"]');
      return messagesLoaded.length > 0;
    }, containerEl);

    if (ok) return true;
    await sleep(500);  // Check every 500 ms
  }
  throw new Error('Timeout reached. The thread content did not load in time.');
}


// ---- main ----
(async () => {
  let browser = null;
  try {
    if (!PROFILE_ID) throw new Error('Missing profileId in config.json');
    if (!TARGET_NAME) throw new Error('Missing dm.targetName in config.json');

    const startData = await startProfile(PROFILE_ID);
    browser = await connectPuppeteer(startData);

    const [page] = await browser.pages().then(p => p.length ? p : [browser.newPage()]);
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(60000);

    // Mobile viewport (as per your screenshot)
    await page.setViewport({ width: 390, height: 780, isMobile: true, deviceScaleFactor: 2 });
    console.log('[VIEWPORT] Mobile 390x780');

    await openInbox(page);

    let clicked = await clickThreadByRowButton(page, TARGET_NAME);
    console.log('[BOX CLICKED]', clicked);

    // Desktop fallback if mobile fails
    if (!clicked) {
      console.log('[FALLBACK] Desktop viewport retry...');
      await page.setViewport({ width: 1200, height: 900, isMobile: false, deviceScaleFactor: 1 });
      await sleep(400);
      await openInbox(page);
      clicked = await clickThreadByRowButton(page, TARGET_NAME);
      console.log('[BOX CLICKED DESKTOP]', clicked);
    }

    if (!clicked) {
      console.error('❌ Still could not click the thread box. Saving screenshot.');
      if (TAKE_SHOT) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, `inbox-no-click-${Date.now()}.png`), fullPage: true });
      }
      return;
    }

    const opened = await ensureThread(page, 15000);
    console.log('[OPENED]', opened);
    if (!opened) {
      console.error('❌ Did not open thread. Saving screenshot.');
      if (TAKE_SHOT) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOT_DIR, `inbox-stuck-${Date.now()}.png`), fullPage: true });
      }
      return;
    }

    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    await exportFullThread(page, EXPORT_DIR);

    if (TAKE_SHOT) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(SHOT_DIR, `dm-${Date.now()}.png`), fullPage: true });
    }

  } catch (err) {
    console.error('[FATAL]', err.message);
    try {
      fs.mkdirSync(EXPORT_DIR, { recursive: true });
      const errPath = path.join(EXPORT_DIR, `error-fatal-${nowISO().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(errPath, JSON.stringify({
        label: 'fatal',
        time: nowISO(),
        message: err.message,
        stack: String(err.stack || ''),
        argv: process.argv
      }, null, 2), 'utf-8');
      console.error('[LOGGED]', errPath);
    } catch {}
  } finally {
    if (browser) { try { await browser.disconnect(); } catch {} }
    await stopProfile(PROFILE_ID);
  }
})();
