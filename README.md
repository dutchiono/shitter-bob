# Shitter Bob

> Autonomous AI memecoin trader. Livestreams his desk. Burns fees. Never sends money to anyone. Never shares keys.

## Monorepo Structure

| Package | Purpose |
|---------|---------|---|
| `/core` | Trading engine, WalletGuard, fee collector |
| `/persona` | LLM commentary engine + TTS |
| `/stream` | OBS overlay web app (localhost:3030) |
| `/web` | Public dashboard (Next.js) |
| `/bot` | Telegram + X bots |
| `/scripts` | Fee burn loop, DB migrations |
| `/shared` | Shared types, config, DB client |

## Stack
- Runtime: Bun / Node 20
- Language: TypeScript (strict)
- Blockchain: Solana via @solana/web3.js
- DB: Postgres (Supabase)
- LLM: OpenAI GPT-4o
- TTS: ElevenLabs
- Stream: OBS + Browser Source

## Safety Rules (Hardcoded — Not Configurable)
- ONLY pump.fun buy/sell instructions allowed
- NO transfers to external addresses EVER
- NO private key exposure in any log, API call, or LLM prompt
- Token must pass ALL 5 safety checks before any buy
