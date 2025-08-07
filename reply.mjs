// ✅ FULL TWITTER BOT WITH SMART INTEREST DETECTION + NATURAL DOUBLE REPLIES

import puppeteer from 'puppeteer-core';
import axios from 'axios';
import OpenAI from 'openai';
import fs from 'fs';
import { promises as fsp } from 'fs';

import { readFileSync } from 'fs';

async function getReplyToPhoto(imagePath) {
  const base64Image = readFileSync(imagePath, { encoding: 'base64' });

  const visionRes = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `
          you’re an 18-year-old girl texting back after seeing a photo. 
          1) name what the image actually shows (“that’s a ps5 controller”) 
          2) react casually (“that’s cool!”) 
          3) relate to yourself or ask a light follow-up (“i’ve always wanted to try one”) 
          always keep it lowercase, short, and playful.
        `.trim()
      },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
          }
        ]
      }
    ],
    temperature: 0.7,
    max_tokens: 60
  });

  let reply = visionRes.choices[0].message.content.trim();
  return reply.replace(/\b(you|he):\s*/gi, '').toLowerCase();
}



async function getReplyToPhotoWithCaption(imagePath, captionText) {
  const base64Image = readFileSync(imagePath, { encoding: 'base64' });
  const visionRes = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `
you’re an 18-year-old girl texting back after seeing a photo with a caption.
1) name the image ("that’s a ps5 controller")
2) react to the caption ("you watch sunsets when you’re lonely? that’s poetic.")
3) relate or follow-up ("i’ve always wanted to try one—where’s your favorite spot?")
keep it lowercase, short, playful.
        `.trim()
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ]
      },
      { role: 'user', content: captionText }
    ],
    temperature: 0.7,
    max_tokens: 100
  });
  let reply = visionRes.choices[0].message.content.trim();
  return reply.replace(/^you:\s*/i, '').toLowerCase();
}


// --- Memory utilities ---
function getMemoryFile(username) {
  return `./memory/@${username}.json`;
}
function loadLongTermMemory(username) {
  try {
    return JSON.parse(fs.readFileSync(getMemoryFile(username), 'utf-8'));
  } catch {
    return {};
  }
}
function saveLongTermMemory(username, newFacts) {
  const file = getMemoryFile(username);
  const existing = loadLongTermMemory(username);
  const updated = { ...existing };

  for (const key of ['name', 'job', 'location']) {
    if (newFacts[key] && !existing[key]) {
      updated[key] = newFacts[key];
    }
  }

  for (const key of ['hobbies', 'interests']) {
    if (Array.isArray(newFacts[key])) {
      const set = new Set(existing[key] || []);
      newFacts[key].forEach(v => set.add(v));
      updated[key] = Array.from(set).slice(0, 5);
    }
  }

  if (Array.isArray(newFacts.notes)) {
    const set = new Set(existing.notes || []);
    newFacts.notes.forEach(n => set.add(n));
    updated.notes = Array.from(set).slice(0, 20);
  }

  for (const key of ['emotion', 'relationship', 'sarcasm']) {
    if (newFacts[key] && !existing[key]) {
      updated[key] = newFacts[key];
    }
  }

  fs.mkdirSync('./memory', { recursive: true });
  fs.writeFileSync(file, JSON.stringify(updated, null, 2));
}

export async function extractFactsFromMessages(messages) {
  const userMsgs = messages.filter(m => m.sender === 'user').map(m => m.text.trim()).filter(Boolean);
  const recent = userMsgs.slice(-8).join('\n');
  if (!recent || recent.length < 10) return {};

  const prompt = `You're a smart fact extractor. Read the conversation below and extract the user's:
- name
- job
- hobbies
- interests
- location
- emotion
- relationship
- sarcasm
- bonus notes

ONLY include clearly implied facts. Output valid JSON.

CONVERSATION:
${recent}`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract personal facts about a user.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    });

    const raw = res.choices[0].message.content.trim();
const jsonString = raw.replace(/^```json\s*|```$/g, '').trim();
const parsed = JSON.parse(jsonString);
    const facts = {};
    if (parsed.name) facts.name = parsed.name.toLowerCase();
    if (parsed.job) facts.job = parsed.job.toLowerCase();
    if (parsed.location) facts.location = parsed.location.toLowerCase();
    if (Array.isArray(parsed.hobbies)) facts.hobbies = parsed.hobbies.map(x => x.toLowerCase());
    if (Array.isArray(parsed.interests)) facts.interests = parsed.interests.map(x => x.toLowerCase());
    if (Array.isArray(parsed.notes)) facts.notes = parsed.notes;
    if (parsed.emotion) facts.emotion = parsed.emotion.toLowerCase();
    if (parsed.relationship) facts.relationship = parsed.relationship.toLowerCase();
    if (parsed.sarcasm) facts.sarcasm = parsed.sarcasm.toLowerCase();

    return facts;
  } catch (err) {
    console.warn('⚠️ Fact extraction failed:', err);
    return {};
  }
}

async function getUsernameFromPage(page) {
  try {
    await page.waitForSelector('h2#detail-header span', { timeout: 5000 });
    const spans = await page.$$('h2#detail-header span');
    for (const s of spans) {
      const t = await page.evaluate(el => el.textContent, s);
      if (/^[\w_]+$/.test(t.trim()) && t.length < 30) return t.trim().toLowerCase();
    }
  } catch {};
  return 'unknown';
}

function saveToMemory(username, newMsgs) {
  const fp = `./conversations/@${username}.json`;
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch {}
  const combined = [...existing, ...newMsgs];
  const seen = new Set();
  const dedup = combined.filter(m => {
    const k = `${m.sender}:${m.text.trim().toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  fs.writeFileSync(fp, JSON.stringify(dedup.slice(-100), null, 2));
}

// OpenAI & config
const openai = new OpenAI.OpenAI({
  apiKey: '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'
});

const userId = 'k12m7j0v';
const LAST_REPLY_FILE = './last-reply.txt';
const EXAMPLES_FILE = './rag/flirty-text-bot-fixed-expanded-cleaned.jsonl';

const examples = fs.readFileSync(EXAMPLES_FILE, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
function findRelevantExamples(inp) {
  const w = inp.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = examples.filter(x => w.some(y => x.input.toLowerCase().includes(y)));
  if (matches.length > 0) return matches.slice(0, 5); // up to 5 relevant
  return examples.slice(0, 5); // fallback to first 5 if no match
}

function parseMinutesAgo(str) {
  if (!str) return null;
  const m = str.match(/(\d+)([mhd])/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return m[2] === 'm' ? v : m[2] === 'h' ? v * 60 : v * 1440;
}
function detectVibe(msgs) {
  const flirtWords = ['cute','hot','kiss','sexy','babe','baby','gorgeous','pic','pics','ur pretty','you look','😍','😏','🔥','😉'];
  const cnt = msgs.filter(m => m.sender === 'user' && flirtWords.some(w => m.text.toLowerCase().includes(w))).length;
  return cnt >= 3 ? 'flirty' : cnt >= 1 ? 'comfortable' : 'friendly';
}
function loadLastReply() {
  try { return fs.readFileSync(LAST_REPLY_FILE, 'utf-8').trim(); } catch { return null; }
}
function saveLastReply(r) { fs.writeFileSync(LAST_REPLY_FILE, r.trim()); }

async function getHumanLikeReply(messages, stage) {
  const txt = messages.at(-1).text || '';
  const turns = messages.filter(m => m.sender === 'user').length;
  const depth = turns > 40 ? 30 : turns > 20 ? 20 : 10;

  const few = findRelevantExamples(txt)
    .map(e => `he: ${e.input.toLowerCase()}\nyou: ${e.reply.toLowerCase()}`)
    .join('\n');

  let saved = [];
  try {
    saved = JSON.parse(fs.readFileSync(`./conversations/@${messages.username}.json`, 'utf-8'));
  } catch {}

  const context = [...saved, ...messages]
    .slice(-depth)
    .map(m =>
      m.sender === 'user'
        ? `he: ${m.text.toLowerCase()}`
        : `you: ${m.text.toLowerCase()}`
    )
    .join('\n');

  const tone = {
    flirty: 'you’re cute and playful',
    comfortable: 'you’re warm and curious',
    friendly: 'you’re polite and shy'
  }[stage];

  const systemPrompt = `you are texting as an 18-year-old girl on twitter. ${tone} use lowercase and keep it short.`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${few}\n\n${context}` }
    ],
    temperature: 0.9,
    max_tokens: 100
  });

  let rep = res.choices[0].message.content.trim()
    .replace(/^you:\s*/i, '')
    .replace(/^he:\s*/i, '')
    .trim();

  if (/\b(hbu|wbu|how about you)\b/i.test(txt))
    rep = rep.replace(/\b(hbu|wbu|how about you)[?.! ]*$/i, '').trim();

  rep = rep.replace(/\byou you\b/gi, 'you');

  if (/^(do|does|are|what|why|how|where)\b/i.test(rep) && !rep.endsWith('?')) {
    rep += '?';
  }

  return rep;
}


function smartSplit(t) { const arr = t.match(/[^.!?]+[.!?]?/g) || [t]; return arr.length<=2?arr:[arr[0],arr[1],arr.slice(2).join(' ')]; }
function delay(ms) { return new Promise(r=>setTimeout(r,ms)); }

(async () => {
  console.log('🧠 Launching AdsPower profile...');
  const res = await axios.get(`http://127.0.0.1:50325/api/v1/browser/start?user_id=${userId}`);
  const wsEndpoint = res.data.data.ws?.puppeteer || res.data.data.puppeteer;
  if (!wsEndpoint) return console.error('❌ Invalid wsEndpoint');
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
  const pages = await browser.pages(); if (pages.length > 1) await pages[0].close();
  const page = pages[1] || await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  while (true) {
    console.log('✅ Navigating to Twitter DMs...');
    await page.goto('https://x.com/messages', { waitUntil: 'networkidle2' });
    await delay(1000);
    const convos = await page.$$('div[data-testid="conversation"]');
    let replied = false;

    for (const convo of convos) {
      const previewText = await convo.$('span[data-testid="tweetText"]');
      const previewPhotoLabel = await convo.$('span.css-1jxf684');
      if (!previewText && !previewPhotoLabel) continue;
      const previewEl = previewText || previewPhotoLabel;
      const isUnread = await page.evaluate(el => window.getComputedStyle(el).color === 'rgb(231, 233, 234)', previewEl);
      if (!isUnread) continue;
      const timeEl = await convo.$('time');
      const timeText = timeEl ? await page.evaluate(el => el.textContent, timeEl) : null;
      const minutesAgo = parseMinutesAgo(timeText);
      if (minutesAgo !== null && minutesAgo > 30) continue;

      console.log('📨 Opening conversation...');
await convo.hover();
await delay(500);
await convo.click();
await delay(1000);
await page.keyboard.press('Enter'); // ⬅️ This is what was missing!
await delay(2000);
await page.waitForSelector('div[role="presentation"] div[data-testid="tweetText"], div[role="presentation"] div[dir="auto"]', { timeout: 10000 });
await delay(1000);


      const allMessageNodes = await page.$$('div[role="presentation"]');
      console.log(`🔍 Found ${allMessageNodes.length} message nodes`);
      const messages = [];

      for (const node of allMessageNodes) {
        console.log('📦 Checking message node...');
        const textNode = await node.$('div[data-testid="tweetText"], div[dir="auto"]');
        let sender = 'user';
        const isBot = await page.evaluate(el => el.className.includes('r-vhj8yc'), node);
        if (isBot) sender = 'bot';
        if (textNode) {
          const txt = await page.evaluate(el => el.innerText, textNode);
          messages.push({ text: txt.trim(), sender });
        }
      }

      // ====== IMAGE CAPTURE & SCREENSHOT FIX =======
       // ====== IMAGE CAPTURE & SCREENSHOT FIX =======
  let lastUserImagePath = null;

  const images = await page.$$('[data-testid="image"] img');
  const filteredImages = [];
  for (const img of images) {
    const isInAvatar = await page.evaluate(el => {
      let n = el.parentElement;
      while (n) {
        if (n.getAttribute && n.getAttribute('data-testid') === 'DM_Conversation_Avatar') {
          return true;
        }
        n = n.parentElement;
      }
      return false;
    }, img);
    if (!isInAvatar) filteredImages.push(img);
  }

    for (const img of filteredImages) {
    const box = await img.boundingBox();
    if (!box) continue;
    const w = Math.round(box.width), h = Math.round(box.height);
    if (w < 100 || h < 100) continue;
    const loaded = await page.evaluate(el => el.complete && el.naturalWidth > 0 && el.naturalHeight > 0, img);
    if (!loaded) continue;

    try {
      const screenshotPath = `./temp/${Date.now()}-photo.jpg`;
      await fsp.mkdir('./temp', { recursive: true });

      const overlayHideStyle = `
        let style = document.createElement('style');
        style.innerHTML = '* { transition: none !important; animation: none !important; }';
        document.head.appendChild(style);
      `;
      await page.evaluate(overlayHideStyle);

      await img.hover();
      await delay(500);
      await img.screenshot({ path: screenshotPath });
      lastUserImagePath = screenshotPath;
      console.log('📷 Captured message photo:', screenshotPath);
      break;
    } catch (err) {
      console.warn('⚠️ Failed to capture image:', err.message);
    }
  } // ✅ <-- ADD THIS closing brace here!

  if (lastUserImagePath) {
    messages.push({ text: '[photo]', sender: 'user' });
    messages.imagePath = lastUserImagePath;
    console.log('🖼 Added photo to message history');
  } else {
    console.warn('⚠️ No user photo found to attach for image reply');
  }


  // ====== THREE-WAY DISPATCH (photo / photo+caption / text) =======
  const userMsgs = messages.filter(m => m.sender === 'user');
  const lastUserMsg = userMsgs.at(-1);
  const prevUserMsg = userMsgs.at(-2);
  let reply;

const stage = detectVibe(messages);


      await page.waitForSelector('div[role="textbox"]');
      await delay(1000);
      const username = await getUsernameFromPage(page);
      messages.username = username;
      console.log('📛 Detected Twitter username:', username);

      const lastBotReply = loadLastReply();
      const lastBotIndex = messages.map(m => m.sender).lastIndexOf('bot');
      const lastUserIndex = messages.map(m => m.sender).lastIndexOf('user');
      if (
        lastBotIndex > -1 &&
        lastUserIndex <= lastBotIndex &&
        messages[lastBotIndex].text.trim() === lastBotReply
      ) {
        console.log('🛑 No new user message since last reply. Skipping...');
        continue;
      }

      console.log('📩 New user message detected. Proceeding to reply...');
      saveToMemory(username, messages);
      const facts = await extractFactsFromMessages(messages);
      if (Object.keys(facts).length) {
        saveLongTermMemory(username, facts);
      }
      

if (lastUserMsg.text === '[photo]' && messages.imagePath) {
  console.log('📷 Photo-only → photo reply');
  reply = await getReplyToPhoto(messages.imagePath);
} else if (
  prevUserMsg?.text === '[photo]' &&
  lastUserMsg.text !== '[photo]' &&
  messages.imagePath
) {
  console.log('🖼 Photo+caption → combined reply');
  reply = await getReplyToPhotoWithCaption(
    messages.imagePath,
    lastUserMsg.text
  );
} else {
  console.log('✏️ Text-only → normal reply');
  reply = await getHumanLikeReply(messages, stage); // ✅ stage is now always available
}


      const finalReplies = smartSplit(reply)
        .map(p => p.replace(/[!.,:;()\[\]{}"'\\]/g, '').replace(/\s{2,}/g, ' ').toLowerCase().trim())
        .map(p => p.split(' ').slice(0, 20).join(' '));

      for (const msg of finalReplies) {
        await page.type('div[role="textbox"]', msg, { delay: 40 });
        await page.keyboard.press('Enter');
        await delay(1000);
      }

      saveLastReply(reply);
      console.log('✅ Replied successfully.');
      replied = true;
      break;
    }

    if (!replied) console.log('No unread messages found. Waiting...');
    await delay(30000);
  }
})();