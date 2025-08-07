import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fs from 'fs';
import OpenAI from 'openai';

dotenv.config();

const app = express();
const port = 3001;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Load examples from file
let examples = [];
try {
  examples = fs
    .readFileSync('./flirty-text-bot-fixed-expanded.jsonl', 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
} catch (err) {
  console.error('⚠️ Failed to load examples:', err.message);
}

// Match user message with examples
function findRelevantExamples(userMessage = '') {
  userMessage = userMessage.toLowerCase();
  return examples.filter(ex =>
    ex.input?.toLowerCase().includes(userMessage.slice(0, 10)) ||
    userMessage.includes(ex.input?.toLowerCase().slice(0, 10))
  ).slice(0, 3);
}

app.use(cors());
app.use(bodyParser.json());

// Generate reply route
app.post('/generate-reply', async (req, res) => {
  try {
    const { messages = [], vibe = 'friendly' } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty message history.' });
    }

    const userText = messages[messages.length - 1]?.text || '';
    const relevant = findRelevantExamples(userText);

    const vibeInstructions = {
      flirty: `you're an 18-year-old girl who's now comfortable texting the guy. you're cute, teasing, and playful. use casual slang and short lowercase replies. avoid emojis unless natural at the end. do not agree to meet up — you can tease but stay distant.`,
      comfortable: `you're an 18-year-old girl who's getting to know the guy and starting to relax. you're warm and soft-spoken, casual and curious. lowercase always. keep it short and natural.`,
      friendly: `you're shy and polite, just getting to know the guy. always lowercase, keep replies short, sweet and friendly.`,
    };

    const contextMessages = messages.slice(-6).map(msg => {
      const speaker = msg.sender === 'user' ? 'he' : 'you';
      return `${speaker}: ${msg.text.toLowerCase()}`;
    }).join('\n');

    const systemPrompt = `
you are texting as an 18-year-old girl on twitter. ${vibeInstructions[vibe] || vibeInstructions.friendly}
use lowercase. keep the reply short and casual. no long paragraphs. never say you're flirty. no proper punctuation except question mark.
    `.trim();

    const fewShot = relevant.map(ex => `he: ${ex.input.toLowerCase()}\nyou: ${ex.reply.toLowerCase()}`).join('\n');

    const finalPrompt = `${systemPrompt}\n\n${fewShot}\n\n${contextMessages}\nyou:`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: finalPrompt }
      ],
      temperature: 0.9,
      max_tokens: 100
    });

    const reply = completion.choices[0]?.message?.content?.trim() || 'hmm ok';
    res.json({ reply });

  } catch (err) {
    console.error('❌ Error generating reply:', err.message);
    res.status(500).json({ error: 'Failed to generate reply.' });
  }
});

app.listen(port, () => {
  console.log(`🚀 RAG server running at http://localhost:${port}`);
});
