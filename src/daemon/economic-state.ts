import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import type { EconomicManager } from "../lib/economic/wallet";

export const ECONOMIC_STATE_FILE = "economic-state.json";

export function loadEconomicState(dataDir: string, economic: EconomicManager): void {
  const file = join(dataDir, ECONOMIC_STATE_FILE);
  if (!existsSync(file)) return;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    economic.load(data);
    const tokenCount = Object.keys(data.tokens || {}).length;
    const walletCount = Object.keys(data.wallets || {}).length;
    console.error(`[Economic] Loaded state: ${tokenCount} tokens, ${walletCount} wallets, ${(data.ledger || []).length} ledger entries`);
  } catch (err) {
    console.error(`[Economic] WARNING: Failed to load state from ${file}: ${(err as Error).message}`);
  }
}

export function saveEconomicState(dataDir: string, economic: EconomicManager): void {
  const file = join(dataDir, ECONOMIC_STATE_FILE);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(economic.serialize(), null, 2));
  } catch (err) {
    console.error(`[Economic] WARNING: Failed to save state to ${file}: ${(err as Error).message}`);
  }
}
