// =============================================================
// core/src/scanner.ts
// Continuous pump.fun scanner via Helius WS + RPC log subscription
// Scores each token with MemeScore, feeds decision queue
// =============================================================

import { Connection, PublicKey, type Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PUMP_PROGRAM, SOLANA_RPC_URL, HELIUS_API_KEY } from '../../shared/src/config';
import type { ScanItem } from '../../shared/src/types';

const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Meme word bonuses for name/ticker scoring
const MEME_WORDS = [
  'pepe','doge','shib','cat','dog','rug','moon','pump','chad','based',
  'wojak','frog','wen','gm','ser','fren','wagmi','ngmi','bonk','bob',
  'trump','elon','sol','ape','monkey','banana','wtf','lol','lmao',
];

interface TokenCandidate {
  mint: string;
  name: string;
  symbol: string;
  devWallet: string;
  createdAt: number;      // ms
  buys: number;
  uniqueBuyers: Set<string>;
  volumeLamports: bigint;
  lastPrice: number;      // SOL per token
  bondingCurvePct: number;
}

export class PumpScanner extends EventEmitter {
  private connection: Connection;
  private candidates = new Map<string, TokenCandidate>();
  private subId: number | null = null;

  constructor() {
    super();
    this.connection = new Connection(
      SOLANA_RPC_URL.replace('https://', 'wss://'),
      { wsEndpoint: HELIUS_WS, commitment: 'confirmed' }
    );
  }

  async start(): Promise<void> {
    console.log('[Scanner] Subscribing to pump.fun program logs...');
    this.subId = this.connection.onLogs(
      new PublicKey(PUMP_PROGRAM),
      (logs: Logs) => this.handleLogs(logs),
      'confirmed'
    );
    // Refresh scores every 10s
    setInterval(() => this.emitTopCandidates(), 10_000);
    console.log('[Scanner] Live — watching pump.fun');
  }

  async stop(): Promise<void> {
    if (this.subId !== null) {
      await this.connection.removeOnLogsListener(this.subId);
    }
  }

  private handleLogs(logs: Logs): void {
    if (logs.err) return;
    const { logs: lines, signature } = logs;

    // Detect new token creation
    if (lines.some(l => l.includes('InitializeMint') || l.includes('create'))) {
      this.handleNewToken(signature, lines);
    }

    // Detect buy events — parse out mint + sol amount from logs
    if (lines.some(l => l.includes('buy'))) {
      this.handleBuy(signature, lines);
    }

    // Detect graduation
    if (lines.some(l => l.includes('complete') || l.includes('graduate'))) {
      this.handleGraduation(lines);
    }
  }

  private handleNewToken(sig: string, lines: string[]): void {
    // Extract mint from log line: "Program log: mint: <address>"
    const mintLine = lines.find(l => l.includes('mint:'));
    const nameLine = lines.find(l => l.includes('name:'));
    const symLine  = lines.find(l => l.includes('symbol:'));
    const devLine  = lines.find(l => l.includes('user:'));

    if (!mintLine) return;
    const mint   = mintLine.split('mint:')[1]?.trim().split(' ')[0];
    const name   = nameLine?.split('name:')[1]?.trim().split(' ')[0] ?? 'UNKNOWN';
    const symbol = symLine?.split('symbol:')[1]?.trim().split(' ')[0] ?? '???';
    const dev    = devLine?.split('user:')[1]?.trim().split(' ')[0] ?? '';

    if (!mint || this.candidates.has(mint)) return;

    this.candidates.set(mint, {
      mint, name, symbol, devWallet: dev,
      createdAt: Date.now(),
      buys: 0,
      uniqueBuyers: new Set(),
      volumeLamports: 0n,
      lastPrice: 0,
      bondingCurvePct: 0,
    });
    console.log(`[Scanner] New token: ${symbol} (${mint.slice(0,8)}...)`);
  }

  private handleBuy(sig: string, lines: string[]): void {
    const mintLine   = lines.find(l => l.includes('mint:'));
    const buyerLine  = lines.find(l => l.includes('user:'));
    const solLine    = lines.find(l => l.includes('sol_amount:'));

    if (!mintLine) return;
    const mint  = mintLine.split('mint:')[1]?.trim().split(' ')[0];
    const buyer = buyerLine?.split('user:')[1]?.trim().split(' ')[0] ?? '';
    const sol   = BigInt(solLine?.split('sol_amount:')[1]?.trim().split(' ')[0] ?? '0');

    if (!mint) return;
    let c = this.candidates.get(mint);
    if (!c) {
      // Late pickup — create stub entry
      c = { mint, name: '?', symbol: '?', devWallet: '', createdAt: Date.now() - 60_000,
             buys: 0, uniqueBuyers: new Set(), volumeLamports: 0n, lastPrice: 0, bondingCurvePct: 0 };
      this.candidates.set(mint, c);
    }
    c.buys++;
    if (buyer) c.uniqueBuyers.add(buyer);
    c.volumeLamports += sol;
  }

  private handleGraduation(lines: string[]): void {
    const mintLine = lines.find(l => l.includes('mint:'));
    if (!mintLine) return;
    const mint = mintLine.split('mint:')[1]?.trim().split(' ')[0];
    if (mint) {
      const c = this.candidates.get(mint);
      if (c) {
        c.bondingCurvePct = 100;
        this.emit('graduated', mint);
      }
    }
  }

  // ----------------------------------------------------------
  // MemeScore: 0-100 composite
  // ----------------------------------------------------------
  private calcMemeScore(c: TokenCandidate): number {
    let score = 0;

    // Name/symbol meme word bonus (0-30)
    const nameTokens = (c.name + ' ' + c.symbol).toLowerCase();
    const wordMatches = MEME_WORDS.filter(w => nameTokens.includes(w)).length;
    score += Math.min(30, wordMatches * 10);

    // Volume velocity (0-25): > 5 SOL in first 5 min is spicy
    const ageMin = (Date.now() - c.createdAt) / 60_000;
    const solVol = Number(c.volumeLamports) / 1e9;
    const volPerMin = ageMin > 0 ? solVol / ageMin : 0;
    score += Math.min(25, volPerMin * 5);

    // Unique buyers (0-25): diverse buyers = healthier
    score += Math.min(25, c.uniqueBuyers.size * 1.5);

    // Bonding curve progress (0-20): sweet spot 20-60%
    const bc = c.bondingCurvePct;
    if (bc >= 20 && bc <= 60) score += 20;
    else if (bc > 60 && bc <= 80) score += 10;

    return Math.round(Math.min(100, score));
  }

  private emitTopCandidates(): void {
    const items: ScanItem[] = [];
    for (const c of this.candidates.values()) {
      const ageSeconds = (Date.now() - c.createdAt) / 1000;
      // Only surface tokens younger than 30 min
      if (ageSeconds > 1800) { this.candidates.delete(c.mint); continue; }
      items.push({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        memeScore: this.calcMemeScore(c),
        bondingCurvePct: c.bondingCurvePct,
        volumeSol: Number(c.volumeLamports) / 1e9,
        uniqueBuyers: c.uniqueBuyers.size,
        ageSeconds,
      });
    }
    items.sort((a, b) => b.memeScore - a.memeScore);
    this.emit('scan_update', items.slice(0, 20));

    // Emit top candidates for trading consideration
    for (const item of items.slice(0, 3)) {
      if (item.memeScore >= 50) {
        this.emit('candidate', item);
      }
    }
  }

  // Called by audience hint system to inject a tip
  injectAudienceTip(mint: string, symbol: string, tipper: string): void {
    if (!this.candidates.has(mint)) {
      this.candidates.set(mint, {
        mint, name: symbol, symbol, devWallet: '',
        createdAt: Date.now(), buys: 0,
        uniqueBuyers: new Set(), volumeLamports: 0n,
        lastPrice: 0, bondingCurvePct: 0,
      });
    }
    this.emit('audience_tip', { mint, symbol, tipper });
  }
}
