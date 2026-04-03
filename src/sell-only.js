import { initClobClient } from "./clob.js";
import { config } from "./config.js";
import { runSellScan } from "./sell-loop.js";
import { loadState } from "./state.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const state = await loadState(config.STATE_FILE);
  const { client } = await initClobClient();
  let iteration = 1;

  while (true) {
    try {
      console.log(`[SELL-ONLY] 开始第 ${iteration} 轮卖出扫描`);
      await runSellScan(client, state);
    } catch (err) {
      console.error("[SELL-ONLY] 卖出扫描失败:", err.message || err);
    }

    if (!config.RUN_FOREVER) {
      break;
    }

    console.log();
    console.log(
      `[SELL-ONLY] 距离下一轮卖出扫描还需等待 ${config.SELL_SCAN_INTERVAL_MS}ms...`
    );
    await sleep(config.SELL_SCAN_INTERVAL_MS);
    console.log();
    iteration += 1;
  }
}

main().catch((err) => {
  console.error("[SELL-ONLY:FATAL] 程序异常退出:", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[SELL-ONLY:CAUSE] 原因: ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
