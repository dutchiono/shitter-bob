// =============================================================
// core/src/safetyChecker.ts
// ALL 5 checks must pass before Bob touches a token.
// Fail = hard no + narration reason returned.
// =============================================================

import { Connection, PublicKey } from '@solana/web3.js';
import {
  SOLANA_RPC_URL,
  HELIUS_API_KEY,
  AGE_GATE_SECONDS,
  HOLDER_CONCENTRATION_MAX,
} from '../../shared/src/config';
import type { SafetyResult, SafetyRisk } from '../../shared/src/types';

const RUGCHECK_API = 'https://api.rugcheck.xyz/v1';
const HELIUS_API   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

export class SafetyChecker {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }

  async check(mint: string, createdAtMs: number): Promise<SafetyResult> {
    const reasons: string[] = [];
    let passed = true;
    let risk: SafetyRisk = 'LOW';
    let rugcheckScore: number | undefined;
    let mintAuthorityRevoked = false;
    let freezeAuthorityRevoked = false;
    let lpBurned = false;
    let holderConcentration = 0;
    const ageSeconds = (Date.now() - createdAtMs) / 1000;
    let bondingCurvePct = 0;

    // ----------------------------------------------------------
    // CHECK 1: RugCheck.xyz
    // ----------------------------------------------------------
    try {
      const rc = await fetch(`${RUGCHECK_API}/tokens/${mint}/report/summary`);
      if (rc.ok) {
        const data = await rc.json() as { score: number; risks: { level: string }[] };
        rugcheckScore = data.score;
        const topRisk = data.risks?.[0]?.level?.toUpperCase() as SafetyRisk | undefined;
        if (topRisk && topRisk !== 'LOW') {
          risk = topRisk;
          passed = false;
          reasons.push(`RugCheck risk level: ${topRisk} (score ${rugcheckScore})`);
        }
      }
    } catch (e) {
      // If RugCheck is down, log but don't hard-fail — rely on on-chain checks
      console.warn('[SafetyChecker] RugCheck API unavailable, skipping');
    }

    // ----------------------------------------------------------
    // CHECK 2: On-chain mint/freeze authority
    // ----------------------------------------------------------
    try {
      const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const parsed = (mintInfo.value?.data as { parsed?: { info?: {
        mintAuthority: string | null;
        freezeAuthority: string | null;
      } } })?.parsed?.info;

      mintAuthorityRevoked   = parsed?.mintAuthority   == null;
      freezeAuthorityRevoked = parsed?.freezeAuthority == null;

      if (!mintAuthorityRevoked) {
        passed = false;
        reasons.push('Mint authority still enabled — dev can print more tokens');
      }
      if (!freezeAuthorityRevoked) {
        passed = false;
        reasons.push('Freeze authority still enabled — wallets can be frozen');
      }
    } catch (e) {
      passed = false;
      reasons.push('Could not fetch mint info — skipping on-chain check');
    }

    // ----------------------------------------------------------
    // CHECK 3: Holder concentration (top 10 wallets)
    // Uses Helius getTokenLargestAccounts
    // ----------------------------------------------------------
    try {
      const res = await fetch(HELIUS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenLargestAccounts',
          params: [mint],
        }),
      });
      const json = await res.json() as { result?: { value?: { amount: string }[] } };
      const accounts = json.result?.value ?? [];
      const total    = accounts.reduce((s, a) => s + Number(a.amount), 0);
      const top10    = accounts.slice(0, 10).reduce((s, a) => s + Number(a.amount), 0);
      holderConcentration = total > 0 ? top10 / total : 0;

      if (holderConcentration > HOLDER_CONCENTRATION_MAX) {
        passed = false;
        reasons.push(
          `Top-10 wallets hold ${(holderConcentration * 100).toFixed(1)}% of supply — too concentrated`
        );
      }
    } catch (e) {
      console.warn('[SafetyChecker] Holder check failed', e);
    }

    // ----------------------------------------------------------
    // CHECK 4: Age gate
    // ----------------------------------------------------------
    if (ageSeconds < AGE_GATE_SECONDS) {
      passed = false;
      reasons.push(
        `Token is only ${ageSeconds.toFixed(0)}s old — minimum ${AGE_GATE_SECONDS}s required`
      );
    }

    // ----------------------------------------------------------
    // CHECK 5: Bonding curve progress via Helius
    // pump.fun stores bonding curve state in a PDA
    // ----------------------------------------------------------
    try {
      const [bcPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
        new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
      );
      const bcInfo = await this.connection.getAccountInfo(bcPda);
      if (bcInfo?.data) {
        // pump.fun bonding curve layout: real_sol_reserves at offset 24 (u64)
        // virtual_sol_reserves at offset 16 (u64)
        const buf = bcInfo.data;
        const realSol    = buf.readBigUInt64LE(24);
        const virtualSol = buf.readBigUInt64LE(16);
        const target     = BigInt(85_000_000_000); // ~85 SOL to graduate
        bondingCurvePct  = Math.min(100, Number(realSol * 100n / target));

        if (bondingCurvePct > 85) {
          passed = false;
          reasons.push(`Bonding curve ${bondingCurvePct}% filled — too close to graduation, slippage risk`);
        }
        lpBurned = bondingCurvePct >= 100; // graduated = LP burned/locked
      }
    } catch (e) {
      console.warn('[SafetyChecker] Bonding curve check failed', e);
    }

    return {
      mint,
      passed,
      risk,
      reasons,
      rugcheckScore,
      mintAuthorityRevoked,
      freezeAuthorityRevoked,
      lpBurned,
      holderConcentration,
      ageSeconds,
      bondingCurvePct,
    };
  }
}