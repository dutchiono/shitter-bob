// =============================================================
// core/src/tradingEngine.ts
// Buy/sell logic — pump.fun program IDL via @coral-xyz/anchor
// All txns routed through WalletGuard before signing
// =============================================================

import { PublicKey, Transaction } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import {
  PUMP_PROGRAM,
  POSITION_SIZE_MIN_PCT,
  POSITION_SIZE_MAX_PCT,
  QUICK_EXIT_TARGET_MULT,
  SLIPPAGE_BPS,
  MOON_BAG_PCT,
} from '../../shared/src/config';
import type { Position, Trade, ScanItem, SafetyResult } from '../../shared/src/types';
import { WalletGuard } from './walletGuard';
import { db } from './db';

const LAMPORTS_PER_SOL = 1_000_000_000n;

export class TradingEngine extends EventEmitter {
  private guard: WalletGuard;
  private openPositions = new Map<string, Position>();  // mint -> Position
  private tradingBalanceLamports = 0n;
  private priceWatchers = new Map<string, NodeJS.Timeout>();

  constructor(guard: WalletGuard) {
    super();
    this.guard = guard;
  }

  async init(): Promise<void> {
    // Load open positions from DB
    const rows = await db.query<Position>(
      `SELECT * FROM positions WHERE status IN ('open','partial','moonbag')`
    );
    for (const pos of rows) {
      this.openPositions.set(pos.mint, pos);
      this.watchPrice(pos);
    }
    // Load trading balance from DB bucket
    const bal = await db.queryOne<{ balance: string }>(
      `SELECT COALESCE(SUM(amount_lamports),0)::text AS balance FROM fees_ledger WHERE bucket='trading_balance'`
    );
    this.tradingBalanceLamports = BigInt(bal?.balance ?? '0');
    console.log(`[TradingEngine] Loaded ${this.openPositions.size} open positions`);
  }

  // ----------------------------------------------------------
  // BUY — called after SafetyChecker passes
  // ----------------------------------------------------------
  async buy(
    item: ScanItem,
    safety: SafetyResult,
    source: 'scan' | 'audience',
    tipper?: string
  ): Promise<Position | null> {
    if (this.openPositions.has(item.mint)) {
      console.log(`[TradingEngine] Already in position for ${item.symbol}`);
      return null;
    }

    // Position sizing: random between MIN and MAX pct of trading balance
    const pct = POSITION_SIZE_MIN_PCT +
      Math.random() * (POSITION_SIZE_MAX_PCT - POSITION_SIZE_MIN_PCT);
    const buyLamports = (this.tradingBalanceLamports * BigInt(Math.floor(pct * 100))) / 10_000n;

    if (buyLamports < 10_000_000n) {  // min 0.01 SOL
      this.emit('commentary', `Not enough trading balance to buy ${item.symbol} — skipping`);
      return null;
    }

    this.emit('commentary',
      `Aping into ${item.symbol} — MemeScore ${item.memeScore}/100, ` +
      `bonding curve ${item.bondingCurvePct}%, spending ${Number(buyLamports)/1e9} SOL`
    );

    try {
      const { tx, expectedTokens, pricePerToken } =
        await this.buildBuyTx(item.mint, buyLamports);

      const txHash = await this.guard.signAndSend(tx);

      const pos: Position = {
        id: uuid(),
        mint: item.mint,
        symbol: item.symbol,
        entryPrice: pricePerToken,
        entryAmountSol: Number(buyLamports) / 1e9,
        tokenAmount: expectedTokens,
        status: 'open',
        quickExitTarget: pricePerToken * QUICK_EXIT_TARGET_MULT,
        quickExitDone: false,
        trailingStopPct: 0.20,
        moonBagAmount: expectedTokens * BigInt(MOON_BAG_PCT) / 100n,
        openedAt: new Date(),
        source,
        tipper,
      };

      await db.query(
        `INSERT INTO positions (id,mint,symbol,entry_price,entry_amount_sol,token_amount,
          status,quick_exit_target,quick_exit_done,trailing_stop_pct,moon_bag_amount,
          opened_at,source,tipper)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [pos.id, pos.mint, pos.symbol, pos.entryPrice, pos.entryAmountSol,
         pos.tokenAmount.toString(), pos.status, pos.quickExitTarget,
         pos.quickExitDone, pos.trailingStopPct, pos.moonBagAmount.toString(),
         pos.openedAt, pos.source, pos.tipper ?? null]
      );

      await this.logTrade({
        id: uuid(), positionId: pos.id, type: 'buy',
        price: pricePerToken, amountSol: Number(buyLamports) / 1e9,
        tokenAmount: expectedTokens, txHash, timestamp: new Date(),
      });

      this.tradingBalanceLamports -= buyLamports;
      this.openPositions.set(item.mint, pos);
      this.watchPrice(pos);
      this.emit('position_update', pos);
      this.emit('trade', { type: 'buy', symbol: item.symbol, price: pricePerToken, txHash });
      return pos;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('commentary', `Buy failed for ${item.symbol}: ${msg}`);
      console.error('[TradingEngine] Buy failed', err);
      return null;
    }
  }

  // ----------------------------------------------------------
  // SELL — partial (quick exit 50%) or full
  // ----------------------------------------------------------
  async sell(
    mint: string,
    reason: string,
    fraction = 1.0   // 0.5 for quick exit, 1.0 for full close
  ): Promise<void> {
    const pos = this.openPositions.get(mint);
    if (!pos) return;

    const isMoonBag = pos.status === 'moonbag';
    let sellAmount = isMoonBag
      ? pos.tokenAmount   // sell whatever is left
      : BigInt(Math.floor(Number(pos.tokenAmount) * fraction));

    // Always keep moon bag if token graduated
    if (!pos.quickExitDone && fraction < 1.0) {
      // Quick exit: sell 50%, keep rest
    } else if (!isMoonBag) {
      // Full exit: sell everything EXCEPT moon bag
      sellAmount = pos.tokenAmount - pos.moonBagAmount;
    }

    this.emit('commentary',
      `Selling ${(fraction * 100).toFixed(0)}% of ${pos.symbol} — reason: ${reason}`
    );

    try {
      const { tx, receivedSol } = await this.buildSellTx(mint, sellAmount);
      const txHash = await this.guard.signAndSend(tx);
      const pnl    = receivedSol - (pos.entryAmountSol * fraction);

      await this.logTrade({
        id: uuid(), positionId: pos.id, type: 'sell',
        price: receivedSol / (Number(sellAmount) / 1e9),
        amountSol: receivedSol, tokenAmount: sellAmount, pnl, txHash,
        timestamp: new Date(),
      });

      this.tradingBalanceLamports += BigInt(Math.floor(receivedSol * 1e9));

      if (fraction < 1.0 && !pos.quickExitDone) {
        pos.quickExitDone = true;
        pos.tokenAmount  -= sellAmount;
        pos.status        = 'partial';
        await db.query(
          `UPDATE positions SET quick_exit_done=true, token_amount=$1, status='partial' WHERE id=$2`,
          [pos.tokenAmount.toString(), pos.id]
        );
      } else if (pos.moonBagAmount > 0n) {
        pos.tokenAmount = pos.moonBagAmount;
        pos.status      = 'moonbag';
        await db.query(
          `UPDATE positions SET status='moonbag', token_amount=$1 WHERE id=$2`,
          [pos.moonBagAmount.toString(), pos.id]
        );
        this.stopWatcher(mint);
        this.emit('commentary',
          `Keeping moon bag of ${pos.symbol} — ${pos.moonBagAmount} tokens. To the moon or zero!`
        );
      } else {
        pos.status    = 'closed';
        pos.closedAt  = new Date();
        await db.query(
          `UPDATE positions SET status='closed', closed_at=$1 WHERE id=$2`,
          [pos.closedAt, pos.id]
        );
        this.openPositions.delete(mint);
        this.stopWatcher(mint);
      }

      this.emit('position_update', pos);
      this.emit('trade', { type: 'sell', symbol: pos.symbol, pnl, txHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit('commentary', `Sell failed for ${pos.symbol}: ${msg}`);
      console.error('[TradingEngine] Sell failed', err);
    }
  }

  // ----------------------------------------------------------
  // Price watcher — polls every 15s, triggers exits
  // ----------------------------------------------------------
  private watchPrice(pos: Position): void {
    let highWatermark = pos.entryPrice;

    const interval = setInterval(async () => {
      try {
        const price = await this.fetchPrice(pos.mint);
        if (price <= 0) return;

        // Quick exit: hit 2x?
        if (!pos.quickExitDone && price >= pos.quickExitTarget) {
          this.emit('commentary',
            `${pos.symbol} hit ${QUICK_EXIT_TARGET_MULT}x! Quick-exiting 50% of position`
          );
          await this.sell(pos.mint, `${QUICK_EXIT_TARGET_MULT}x target hit`, 0.5);
          return;
        }

        // Force exit: 1-10 minute window — if we're 10 min in with no 2x, cut at breakeven or stop
        const ageMin = (Date.now() - pos.openedAt.getTime()) / 60_000;
        if (!pos.quickExitDone && ageMin >= 10) {
          await this.sell(pos.mint, '10-min timer — cutting position', 0.5);
        }

        // Trailing stop on remainder
        if (pos.quickExitDone || pos.status === 'partial') {
          if (price > highWatermark) highWatermark = price;
          const stopPrice = highWatermark * (1 - pos.trailingStopPct);
          if (price <= stopPrice) {
            await this.sell(pos.mint,
              `Trailing stop hit — price ${price.toFixed(8)} <= stop ${stopPrice.toFixed(8)}`
            );
          }
        }
      } catch (e) {
        console.warn('[TradingEngine] Price watch error', e);
      }
    }, 15_000);

    this.priceWatchers.set(pos.mint, interval);
  }

  private stopWatcher(mint: string): void {
    const t = this.priceWatchers.get(mint);
    if (t) { clearInterval(t); this.priceWatchers.delete(mint); }
  }

  // ----------------------------------------------------------
  // Stub builders — implement with pump.fun SDK / IDL
  // ----------------------------------------------------------
  private async buildBuyTx(
    mint: string, lamports: bigint
  ): Promise<{ tx: Transaction; expectedTokens: bigint; pricePerToken: number }> {
    // TODO: construct pump.fun buy instruction via Anchor IDL
    // pump.fun program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
    // instruction: "buy" with args: { amount: u64, maxSolCost: u64 }
    throw new Error('buildBuyTx: not yet implemented — wire up pump.fun SDK');
  }

  private async buildSellTx(
    mint: string, tokenAmount: bigint
  ): Promise<{ tx: Transaction; receivedSol: number }> {
    // TODO: construct pump.fun sell instruction
    // instruction: "sell" with args: { amount: u64, minSolOutput: u64 }
    throw new Error('buildSellTx: not yet implemented — wire up pump.fun SDK');
  }

  private async fetchPrice(mint: string): Promise<number> {
    // TODO: fetch current price from pump.fun bonding curve PDA
    return 0;
  }

  private async logTrade(trade: Trade): Promise<void> {
    await db.query(
      `INSERT INTO trades (id,position_id,type,price,amount_sol,token_amount,pnl,tx_hash,timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [trade.id, trade.positionId, trade.type, trade.price, trade.amountSol,
       trade.tokenAmount.toString(), trade.pnl ?? null, trade.txHash, trade.timestamp]
    );
  }
}