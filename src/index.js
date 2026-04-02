import { config } from "./config.js";
import { initClobClient } from "./clob.js";
import { loadState, saveState } from "./state.js";
import { runBuyScan } from "./buy-loop.js";
import { runSellScan } from "./sell-loop.js";
import { createCircuitBreaker } from "./risk.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const state = await loadState(config.STATE_FILE);
  const pendingTokenIDs = new Set();
  const circuitBreaker = createCircuitBreaker(config);
  let buyIteration = 1;

  if (config.DRY_RUN) {
    await runBuyScan(null, state, buyIteration, pendingTokenIDs, circuitBreaker);
    return;
  }

  const client = await initClobClient();

  // Run initial sell scan to process existing positions
  try {
    await runSellScan(client, state);
  } catch (err) {
    console.error("[SELL] Initial scan failed:", err.message);
  }

  // Start sell loop on its own interval
  let sellRunning = false;
  const sellInterval = setInterval(async () => {
    if (sellRunning) {
      console.log("[SELL] Previous scan still running, skipping...");
      return;
    }
    sellRunning = true;
    try {
      await runSellScan(client, state);
    } catch (err) {
      console.error("[SELL] Scan failed:", err.message);
    } finally {
      sellRunning = false;
    }
  }, config.SELL_SCAN_INTERVAL_MS);

  // Buy loop
  while (true) {
    try {
      await runBuyScan(client, state, buyIteration, pendingTokenIDs, circuitBreaker);
    } catch (err) {
      console.error("[BUY] Scan failed:", err.message);
    }

    if (!config.RUN_FOREVER) break;

    console.log();
    console.log(`[Loop] Sleeping ${config.SCAN_INTERVAL_MS}ms before next buy scan...`);
    await sleep(config.SCAN_INTERVAL_MS);
    console.log();
    buyIteration++;
  }

  clearInterval(sellInterval);
}

main().catch((err) => {
  console.error("[FATAL]", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[CAUSE] ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
