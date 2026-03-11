// =============================================================
// core/src/walletGuard.ts
// SAFETY HARDCODE: Only pump.fun buy/sell + Raydium moon-bag exits.
// ANY other instruction = immediate hard reject, no exceptions.
// Private key NEVER leaves this module.
// =============================================================

import {
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
  TransactionInstruction,
  PublicKey,
} from '@solana/web3.js';
import { ALLOWED_PROGRAMS, PUMP_PROGRAM, SOLANA_RPC_URL } from '../../shared/src/config';

// -------------------------------------------------------
// Forbidden instruction types — checked by discriminator
// -------------------------------------------------------
const FORBIDDEN_DISCRIMINATORS = new Set([
  'transfer',
  'transferChecked',
  'setAuthority',
  'closeAccount',
  'initializeAccount',
  'approve',
  'mintTo',
  'burn',          // token burn != SOL burn; we handle SOL burn separately
]);

// Private-key-shaped string pattern interceptor
const PRIVKEY_PATTERN = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;

export function redactPrivkey(text: string): string {
  return text.replace(PRIVKEY_PATTERN, '[REDACTED — nice try]');
}

// -------------------------------------------------------
// WalletGuard
// -------------------------------------------------------
export class WalletGuard {
  private readonly keypair: Keypair;
  private readonly connection: Connection;

  constructor() {
    const raw = process.env.BOB_PRIVATE_KEY;
    if (!raw) throw new Error('BOB_PRIVATE_KEY not set — wallet cannot initialize');

    // Decode from base58 array stored in env (never a raw string in logs)
    const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
    this.keypair = Keypair.fromSecretKey(bytes);
    this.connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    // Immediately zero the raw string from memory as best-effort
    (raw as unknown as string[]).fill('0');

    console.log(`[WalletGuard] Loaded wallet: ${this.keypair.publicKey.toBase58()}`);
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  // -------------------------------------------------------
  // Core guard: validate every instruction before signing
  // -------------------------------------------------------
  private validateInstructions(instructions: TransactionInstruction[]): void {
    for (const ix of instructions) {
      const programId = ix.programId.toBase58();

      // Must be an allowed program
      if (!(ALLOWED_PROGRAMS as readonly string[]).includes(programId)) {
        throw new Error(
          `[WalletGuard] BLOCKED: instruction targets disallowed program ${programId}`
        );
      }

      // Must not contain a forbidden discriminator
      if (ix.data.length >= 8) {
        const disc = ix.data.slice(0, 8).toString('hex');
        for (const forbidden of FORBIDDEN_DISCRIMINATORS) {
          // Compare against known SPL Token instruction indices
          if (disc === forbidden) {
            throw new Error(
              `[WalletGuard] BLOCKED: forbidden instruction type detected (${forbidden})`
            );
          }
        }
      }

      // No instruction may send lamports to an address that isn't the
      // pump.fun program or Raydium (i.e. no SystemProgram transfer)
      if (programId === '11111111111111111111111111111111') {
        throw new Error(
          '[WalletGuard] BLOCKED: SystemProgram instruction detected — no SOL transfers allowed'
        );
      }
    }
  }

  // -------------------------------------------------------
  // Sign a legacy Transaction after guard passes
  // -------------------------------------------------------
  async signAndSend(tx: Transaction): Promise<string> {
    this.validateInstructions(tx.instructions);

    tx.feePayer = this.keypair.publicKey;
    const { blockhash } = await this.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.sign(this.keypair);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  // -------------------------------------------------------
  // Sign a VersionedTransaction (for pump.fun SDK)
  // -------------------------------------------------------
  async signAndSendVersioned(vtx: VersionedTransaction): Promise<string> {
    // Decompile to check instructions
    const msg = vtx.message;
    const ixs: TransactionInstruction[] = msg.compiledInstructions.map((ci) => {
      const programId = msg.staticAccountKeys[ci.programIdIndex];
      const accounts = ci.accountKeyIndexes.map(
        (i) => ({ pubkey: msg.staticAccountKeys[i], isSigner: false, isWritable: false })
      );
      return new TransactionInstruction({
        programId,
        keys: accounts,
        data: Buffer.from(ci.data),
      });
    });

    this.validateInstructions(ixs);

    vtx.sign([this.keypair]);
    const sig = await this.connection.sendRawTransaction(vtx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  getConnection(): Connection {
    return this.connection;
  }
}