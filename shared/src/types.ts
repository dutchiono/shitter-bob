// =============================================================
// shared/src/types.ts — Shared domain types across all packages
// =============================================================

export type SafetyRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';

export interface SafetyResult {
  mint: string;
  passed: boolean;
  risk: SafetyRisk;
  reasons: string[];          // human-readable fail reasons for Bob to narrate
  rugcheckScore?: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurned: boolean;
  holderConcentration: number; // 0-1, top-10 wallets % of supply
  ageSeconds: number;
  bondingCurvePct: number;     // 0-100
}

export interface TokenMeta {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  createdAt: Date;
  devWallet: string;
  safetyScore?: SafetyResult;
  memeScore?: number;          // 0-100 composite score
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  entryPrice: number;          // in SOL
  entryAmountSol: number;
  tokenAmount: bigint;
  status: 'open' | 'partial' | 'closed' | 'moonbag';
  quickExitTarget: number;     // price at which first 50% exits
  quickExitDone: boolean;
  trailingStopPct: number;     // e.g. 0.20 = 20% trailing stop
  moonBagAmount: bigint;
  openedAt: Date;
  closedAt?: Date;
  source: 'scan' | 'audience';
  tipper?: string;             // telegram/x handle if audience tip
}

export interface Trade {
  id: string;
  positionId: string;
  type: 'buy' | 'sell';
  price: number;
  amountSol: number;
  tokenAmount: bigint;
  pnl?: number;                // SOL profit/loss (sells only)
  txHash: string;
  timestamp: Date;
}

export interface FeeEntry {
  id: string;
  tradeId: string;
  amountLamports: bigint;
  bucket: 'burn_queue' | 'dev_fund' | 'trading_balance';
  timestamp: Date;
}

export interface BurnEvent {
  id: string;
  amountLamports: bigint;
  burnPct: number;
  txHash: string;
  timestamp: Date;
}

export interface AudienceTip {
  id: string;
  source: 'telegram' | 'x';
  userHandle: string;
  mint: string;
  tipTime: Date;
  result: 'pending' | 'rejected' | 'queued' | 'traded' | 'win' | 'loss';
  positionId?: string;
}

// WebSocket event types broadcast from core -> overlay
export type WsEventType =
  | 'balance'
  | 'scan_update'
  | 'position_update'
  | 'trade'
  | 'commentary'
  | 'burn'
  | 'chat_message';

export interface WsEvent<T = unknown> {
  type: WsEventType;
  payload: T;
  ts: number;
}

export interface ScanItem {
  mint: string;
  symbol: string;
  name: string;
  memeScore: number;
  bondingCurvePct: number;
  volumeSol: number;
  uniqueBuyers: number;
  ageSeconds: number;
  safetyPassed?: boolean;
}
