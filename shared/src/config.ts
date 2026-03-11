// =============================================================
// shared/src/config.ts
// Central config — all secrets come from env, never hardcoded
// =============================================================

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P' as const;
export const RAYDIUM_AMM   = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' as const;
export const SOLANA_BURN_ADDRESS = '1111111111111111111111111111111111111111111' as const;

export const ALLOWED_PROGRAMS = [PUMP_PROGRAM, RAYDIUM_AMM] as const;
export type AllowedProgram = typeof ALLOWED_PROGRAMS[number];

export const FEE_BURN_MIN_PCT   = 25;
export const FEE_BURN_MAX_PCT   = 50;
export const FEE_DEV_PCT        = 50;
export const FEE_TRADING_PCT    = 25;

export const POSITION_SIZE_MIN_PCT  = 1;
export const POSITION_SIZE_MAX_PCT  = 3;
export const QUICK_EXIT_TARGET_MULT = 2.0;
export const SLIPPAGE_BPS           = 1000;
export const MOON_BAG_PCT           = 10;
export const AGE_GATE_SECONDS       = 90;
export const HOLDER_CONCENTRATION_MAX = 0.30;

export const BURN_INTERVAL_MS = 30 * 60 * 1000;

export const DEV_WALLET = process.env.DEV_WALLET_ADDRESS ?? '';
export const SOLANA_RPC_URL  = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
export const HELIUS_API_KEY  = process.env.HELIUS_API_KEY ?? '';

export const OVERLAY_PORT = 3030;
export const OVERLAY_WS_PATH = '/ws';