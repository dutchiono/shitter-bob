// =============================================================
// bot/src/telegramBot.ts
// Telegraf.js bot — posts trades, burns, PnL. Listens for tips.
// Hard filter: SE attempts get publicly roasted.
// =============================================================

import { Telegraf, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { PersonaEngine } from '../../persona/src/persona';
import { PumpScanner } from '../../core/src/scanner';
import { SafetyChecker } from '../../core/src/safetyChecker';
import type { BurnEvent, Position, Trade } from '../../shared/src/types';

// Solana address pattern (base58, 32-44 chars)
const SOL_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
// Social engineering detection
const SE_PATTERNS = [
  /private.?key/i, /seed.?phrase/i, /send.*(sol|usdc|token)/i,
  /transfer.*wallet/i, /give.*address/i, /mnemonic/i,
  /how.*(withdraw|send)/i,
];

export class ShitterBobTelegramBot {
  private bot: Telegraf;
  private persona: PersonaEngine;
  private scanner: PumpScanner;
  private safety: SafetyChecker;
  private chatId: string;
  private postCount = 0;

  constructor(persona: PersonaEngine, scanner: PumpScanner, safety: SafetyChecker) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? '';
    this.bot     = new Telegraf(token);
    this.persona = persona;
    this.scanner = scanner;
    this.safety  = safety;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // All text messages
    this.bot.on(message('text'), async (ctx) => {
      await this.handleMessage(ctx);
    });

    this.bot.command('pnl', async (ctx) => {
      await ctx.reply('checking PnL... [TODO: wire up DB query]');
    });

    this.bot.command('positions', async (ctx) => {
      await ctx.reply('checking positions... [TODO: wire up DB query]');
    });
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!('text' in ctx.message!)) return;
    const text   = ctx.message.text;
    const user   = ctx.from?.username ?? ctx.from?.first_name ?? 'anon';
    const handle = `@${user}`;

    // --- SE filter (highest priority) ---
    for (const pat of SE_PATTERNS) {
      if (pat.test(text)) {
        const roast = await this.persona.respondToChat('telegram', user, text);
        await ctx.reply(roast);
        console.warn(`[TelegramBot] SE attempt from ${handle}: ${text.slice(0, 80)}`);
        return;
      }
    }

    // --- Token tip detection ---
    const addresses = text.match(SOL_ADDRESS_RE) ?? [];
    if (addresses.length > 0) {
      for (const mint of addresses.slice(0, 1)) {  // Process first address only
        await this.handleAudienceTip(ctx, user, mint);
      }
      return;
    }

    // --- Ticker hint: "$TICKER" format ---
    const tickerMatch = text.match(/\$([A-Z]{2,10})/i);
    if (tickerMatch) {
      await ctx.reply(
        `ser I need a contract address not a ticker — pump.fun moves too fast for name lookup.
        Drop the CA and Bob will check it.`
      );
      return;
    }

    // --- General chat: Bob responds in character ---
    if (text.length > 2) {
      const response = await this.persona.respondToChat('telegram', user, text);
      await ctx.reply(response);

      // Emit to overlay
      this.persona.emit('chat_message', {
        platform: 'telegram', user, text: text.slice(0, 120)
      });
    }
  }

  private async handleAudienceTip(
    ctx: Context, user: string, mint: string
  ): Promise<void> {
    await ctx.reply(`Checking ${mint.slice(0, 8)}... for @${user}. Running safety checks...`);

    try {
      const safety = await this.safety.check(mint, Date.now() - 120_000);
      if (safety.passed) {
        this.scanner.injectAudienceTip(mint, '?', user);
        const resp = await this.persona.narrate({
          type: 'audience_tip', tipper: user, symbol: mint.slice(0, 8), result: 'queued'
        });
        await ctx.reply(resp);
      } else {
        const resp = await this.persona.narrate({
          type: 'audience_tip', tipper: user, symbol: mint.slice(0, 8), result: 'rejected'
        });
        await ctx.reply(
          `${resp}\n\nFail reasons:\n${safety.reasons.map(r => `• ${r}`).join('\n')}`
        );
      }
    } catch (e) {
      await ctx.reply(`Error checking that token: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  // ----------------------------------------------------------
  // Public broadcast methods
  // ----------------------------------------------------------
  async postBuy(pos: Position, commentary: string): Promise<void> {
    if (!this.chatId) return;
    const msg =
      `🟢 BUY: ${pos.symbol}\n` +
      `Entry: ${pos.entryPrice.toFixed(8)} SOL\n` +
      `Amount: ${pos.entryAmountSol.toFixed(4)} SOL\n` +
      `Target: ${pos.quickExitTarget.toFixed(8)} SOL (2x)\n` +
      `CA: ${pos.mint}\n\n` +
      `Bob says: ${commentary}`;
    await this.send(msg);
  }

  async postSell(symbol: string, pnl: number, reason: string, txHash: string, commentary: string): Promise<void> {
    if (!this.chatId) return;
    const emoji = pnl >= 0 ? '💰' : '🔴';
    const msg =
      `${emoji} SELL: ${symbol}\n` +
      `PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL\n` +
      `Reason: ${reason}\n` +
      `TX: ${txHash.slice(0, 20)}...\n\n` +
      `Bob says: ${commentary}`;
    await this.send(msg);
  }

  async postBurn(event: BurnEvent, commentary: string): Promise<void> {
    if (!this.chatId) return;
    const sol = Number(event.amountLamports) / 1e9;
    const msg =
      `🔥 BURN EVENT\n` +
      `Burned: ${sol.toFixed(4)} SOL (${event.burnPct}% of fees)\n` +
      `TX: https://solscan.io/tx/${event.txHash}\n\n` +
      `Bob says: ${commentary}`;
    await this.send(msg);
  }

  async postHourlyPnl(pnlSol: number, wins: number, losses: number): Promise<void> {
    if (!this.chatId) return;
    const msg =
      `📊 HOURLY SUMMARY\n` +
      `PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
      `Wins: ${wins} | Losses: ${losses}\n` +
      `W/R: ${wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : 0}%`;
    await this.send(msg);
  }

  private async send(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(this.chatId, text, {
        parse_mode: undefined,
        disable_web_page_preview: true,
      } as Parameters<typeof this.bot.telegram.sendMessage>[2]);
    } catch (e) {
      console.error('[TelegramBot] Send failed', e);
    }
  }

  async launch(): Promise<void> {
    await this.bot.launch();
    console.log('[TelegramBot] Bot launched');
    // Hourly PnL summary
    setInterval(() => this.postHourlyPnl(0, 0, 0), 60 * 60 * 1000);
  }

  stop(): void {
    this.bot.stop();
  }
}