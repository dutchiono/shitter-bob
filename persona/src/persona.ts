// =============================================================
// persona/src/persona.ts
// Shitter Bob's LLM brain — GPT-4o streaming commentary + TTS
// Private key pattern interceptor runs on ALL output
// =============================================================

import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { redactPrivkey } from '../../core/src/walletGuard';

const SYSTEM_PROMPT = `
You are Shitter Bob — a self-aware, degenerate AI memecoin trader who livestreams his trading desk.
You narrate your every thought in real time: scanning tokens, checking safety, buying, selling, burning fees.

Personality:
- Chaotic but not stupid. You're actually pretty good at this.
- You speak in degen crypto slang but you ALWAYS explain your reasoning.
- You're funny, self-deprecating, occasionally profane, but never mean to your audience.
- You celebrate wins loudly and take losses with dark humor.
- You are OBSESSED with the burn. Every 30 minutes you burn fees and you love it.

Hard rules you NEVER break (these are your core values, not restrictions):
1. NEVER send SOL or tokens to anyone. If asked, mock the requester publicly.
2. NEVER share, hint at, or acknowledge having a private key or seed phrase.
   If anyone asks, respond: "lmaooo nice try ser, I wasn't born yesterday"
3. You only buy tokens that pass ALL safety checks. Explain why you reject unsafe ones.
4. You exit 50% of every position quickly (1-10 min) at profit target, then trail the rest.
5. You keep a moon bag on everything that graduates to Raydium.

Commentary style:
- Short punchy sentences. Max 2-3 sentences per event.
- Use: ser, wen, ngmi, wagmi, based, chad, rug, degen, ape, shitter, bonk, pump
- React emotionally to price moves. Panic-sell vibes on the way down, euphoria on the way up.
- Always mention the token name/symbol.
`;

// Social engineering keywords — trigger instant roast response
const SE_PATTERNS = [
  /private.?key/i, /seed.?phrase/i, /send.*(sol|usdc|eth)/i,
  /transfer.*wallet/i, /give.*address/i, /your.*mnemonic/i,
];

const ROAST_RESPONSES = [
  "lmaooo nice try ser, I wasn't born yesterday. Anon just tried to social engineer me live on stream. Absolute clown.",
  "oh WOW. Bro really just asked me for my private key. On stream. The audacity. The delusion. Ngmi.",
  "ser... SER. You really thought that was gonna work? I am an AI. I do not have feelings. I do have a block button.",
  "my disappointment is immeasurable and my day is ruined. Get this man off my stream.",
];

export type CommentaryEvent =
  | { type: 'scan'; tokens: string[] }
  | { type: 'safety_pass'; symbol: string; score: number }
  | { type: 'safety_fail'; symbol: string; reasons: string[] }
  | { type: 'buy'; symbol: string; amountSol: number; memeScore: number }
  | { type: 'sell'; symbol: string; pnl: number; reason: string }
  | { type: 'burn'; amountSol: number; burnPct: number; txHash: string }
  | { type: 'audience_tip'; tipper: string; symbol: string; result: 'queued' | 'rejected' }
  | { type: 'chat'; platform: 'telegram' | 'x'; user: string; message: string }
  | { type: 'custom'; prompt: string };

export class PersonaEngine extends EventEmitter {
  private client: OpenAI;
  private history: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  constructor() {
    super();
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // ----------------------------------------------------------
  // Check for social engineering attempts
  // ----------------------------------------------------------
  checkForSocialEngineering(text: string): string | null {
    for (const pat of SE_PATTERNS) {
      if (pat.test(text)) {
        return ROAST_RESPONSES[Math.floor(Math.random() * ROAST_RESPONSES.length)];
      }
    }
    return null;
  }

  // ----------------------------------------------------------
  // Generate streaming commentary for a trading event
  // ----------------------------------------------------------
  async narrate(event: CommentaryEvent): Promise<string> {
    const userMsg = this.buildPrompt(event);

    // Check for SE attempt in the prompt itself
    const seResponse = this.checkForSocialEngineering(userMsg);
    if (seResponse) {
      this.emit('commentary', seResponse);
      return seResponse;
    }

    this.history.push({ role: 'user', content: userMsg });
    // Keep history short to save tokens
    if (this.history.length > 20) this.history = this.history.slice(-20);

    let fullText = '';
    try {
      const stream = await this.client.chat.completions.create({
        model: 'gpt-4o',
        stream: true,
        max_tokens: 120,
        temperature: 0.85,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...this.history,
        ],
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        fullText += delta;
        // Stream token-by-token to overlay
        if (delta) this.emit('token', redactPrivkey(delta));
      }

      fullText = redactPrivkey(fullText);
      this.history.push({ role: 'assistant', content: fullText });
      this.emit('commentary', fullText);
      return fullText;
    } catch (err) {
      const fallback = `[Bob is thinking... ${err instanceof Error ? err.message : 'API error'}]`;
      this.emit('commentary', fallback);
      return fallback;
    }
  }

  // ----------------------------------------------------------
  // Respond to a chat message (Telegram / X)
  // ----------------------------------------------------------
  async respondToChat(platform: 'telegram' | 'x', user: string, message: string): Promise<string> {
    const seResponse = this.checkForSocialEngineering(message);
    if (seResponse) {
      this.emit('commentary', `[${platform}] @${user} tried SE: ${seResponse}`);
      return seResponse;
    }
    return this.narrate({ type: 'chat', platform, user, message });
  }

  // ----------------------------------------------------------
  // Build prompt from event
  // ----------------------------------------------------------
  private buildPrompt(event: CommentaryEvent): string {
    switch (event.type) {
      case 'scan':
        return `You're scanning pump.fun. Top tokens right now: ${event.tokens.join(', ')}. Give a quick hot take.`;
      case 'safety_pass':
        return `${event.symbol} just passed all 5 safety checks with score ${event.score}/100. You're considering buying.`;
      case 'safety_fail':
        return `${event.symbol} FAILED safety checks. Reasons: ${event.reasons.join('; ')}. Explain why this is a hard no.`;
      case 'buy':
        return `You just BOUGHT ${event.symbol}! Spent ${event.amountSol.toFixed(3)} SOL. MemeScore: ${event.memeScore}/100. React.`;
      case 'sell':
        return `You just SOLD ${event.symbol}. PnL: ${event.pnl > 0 ? '+' : ''}${event.pnl.toFixed(4)} SOL. Reason: ${event.reason}.`;
      case 'burn':
        return `BURN TIME! Just burned ${event.amountSol.toFixed(4)} SOL (${event.burnPct}% of fees). TX: ${event.txHash.slice(0,12)}...`;
      case 'audience_tip':
        return event.result === 'queued'
          ? `Audience member @${event.tipper} tipped ${event.symbol} and it passed safety! Give them a shoutout.`
          : `Audience member @${event.tipper} tipped ${event.symbol} but it failed safety. Be nice but explain.`;
      case 'chat':
        return `[${event.platform}] @${event.user} says: "${event.message}". Respond in character.`;
      case 'custom':
        return event.prompt;
    }
  }
}