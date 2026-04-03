import { config } from "./config.js";
import { initClobClient } from "./clob.js";
import { loadState } from "./state.js";
import { runBuyScan } from "./buy-loop.js";
import { runSellScan } from "./sell-loop.js";
import { createCircuitBreaker } from "./risk.js";
import { createWsSellTrigger } from "./ws-sell.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSellScheduler(client, state) {
  let sellRunning = false;
  let sellQueued = false;
  let stopped = false;

  const runSellWorker = async () => {
    if (sellRunning || stopped) return;
    sellRunning = true;

    try {
      do {
        sellQueued = false;
        try {
          await runSellScan(client, state);
        } catch (err) {
          console.error("[SELL] 扫描失败:", err.message);
        }
      } while (sellQueued && !stopped);
    } finally {
      sellRunning = false;
    }
  };

  const requestSellScan = (reason) => {
    if (stopped) return;

    if (sellRunning) {
      if (!sellQueued) {
        sellQueued = true;
        console.log(`[SELL] ${reason} 触发时上一轮仍在运行，已排队补跑一轮。`);
      }
      return;
    }

    void runSellWorker();
  };

  requestSellScan("启动卖出扫描");

  const sellInterval = setInterval(() => {
    requestSellScan(`卖出定时器（${config.SELL_SCAN_INTERVAL_MS}ms）`);
  }, config.SELL_SCAN_INTERVAL_MS);

  return async () => {
    stopped = true;
    clearInterval(sellInterval);

    while (sellRunning) {
      await sleep(100);
    }
  };
}

async function main() {
  const state = await loadState(config.STATE_FILE);
  const pendingTokenIDs = new Set();
  const circuitBreaker = createCircuitBreaker(config);
  let buyIteration = 1;

  if (config.DRY_RUN) {
    await runBuyScan(null, state, buyIteration, pendingTokenIDs, circuitBreaker);
    return;
  }

  const { client, creds } = await initClobClient();

  const wsTrigger = createWsSellTrigger(client, creds, state);
  wsTrigger.start();

  const stopSellScheduler = startSellScheduler(client, state);

  // Buy loop
  while (true) {
    try {
      await runBuyScan(client, state, buyIteration, pendingTokenIDs, circuitBreaker);
    } catch (err) {
      console.error("[BUY] 扫描失败:", err.message);
    }

    if (!config.RUN_FOREVER) break;

    console.log();
    console.log(`[Loop] 距离下一轮买入扫描还需等待 ${config.SCAN_INTERVAL_MS}ms...`);
    await sleep(config.SCAN_INTERVAL_MS);
    console.log();
    buyIteration++;
  }

  wsTrigger.stop();
  await stopSellScheduler();
}

main().catch((err) => {
  console.error("[FATAL] 程序异常退出:", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[CAUSE] 原因: ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
