import { writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { fetchAllActiveMarkets } from "./gamma.js";
import { filterMarkets } from "./filters.js";
import { appendJsonlWithRotation } from "./persistence.js";
import {
  getAccountOpenOrders,
  placeOrdersBatch,
} from "./clob.js";
import {
  getActiveTrackedTokenIDs,
  saveState,
  upsertToken,
  transitionToken,
} from "./state.js";
import { States } from "./state-machine.js";

function unionSets(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function chunkArray(items, size) {
  const batchSize = Math.max(1, size);
  const chunks = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

function logCategorySummary(categoryCounts, excludedCounts) {
  for (const [category, count] of Object.entries(categoryCounts)) {
    console.log(`${category}: ${count}`);
  }
  if (excludedCounts) {
    for (const [key, count] of Object.entries(excludedCounts)) {
      console.log(`排除_${key.toUpperCase()}: ${count}`);
    }
  }
}

async function appendOrderErrorLog(entry) {
  await appendJsonlWithRotation(config.ERROR_LOG_FILE, entry, {
    maxBytes: config.ERROR_LOG_MAX_BYTES,
    keepFiles: config.LOG_ROTATION_KEEP_FILES,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exportDryRunTargets(targets) {
  const jsonPath = "scanned-targets.json";
  const txtPath = "scanned-targets.txt";

  const jsonOutput = JSON.stringify(targets, null, 2);
  const txtOutput = targets
    .map((target, index) => {
      return [
        `${index + 1}. [${target.category}] ${target.question}`,
        `   event: ${target.eventTitle || "-"}`,
        `   group: ${target.groupItemTitle || "-"}`,
        `   slug: ${target.slug || "-"}`,
        `   token: ${target.tokenID}`,
      ].join("\n");
    })
    .join("\n\n");

  await writeFile(jsonPath, jsonOutput, "utf8");
  await writeFile(txtPath, txtOutput, "utf8");
  console.log(`[DRY RUN] 已导出目标列表到 ${jsonPath} 和 ${txtPath}`);
}

export async function runBuyScan(client, state, iteration, pendingTokenIDs, circuitBreaker) {
  console.log("=== 买入扫描 ===");
  console.log(
    `价格: ${config.ORDER_PRICE}, 数量: ${config.ORDER_SIZE}, DRY_RUN: ${config.DRY_RUN}, 轮次: ${iteration}`
  );
  console.log();

  // Phase 1: Discover
  console.log("--- 阶段 1: 发现市场 ---");
  const markets = await fetchAllActiveMarkets();
  console.log();

  // Phase 2: Filter
  console.log("--- 阶段 2: 过滤市场 ---");
  const { categoryCounts, excludedCounts, allTargets } = filterMarkets(markets);

  if (allTargets.length === 0) {
    console.log("[完成] 没有找到符合条件的市场。");
    return;
  }
  console.log();

  // Phase 3: Dedup + Auth
  console.log("--- 阶段 3: 鉴权与去重 ---");
  if (config.DRY_RUN) {
    console.log("[DRY RUN] 跳过鉴权和下单");
    console.log();
    console.log("--- DRY RUN: 以下市场原本会被下单 ---");
    for (let i = 0; i < allTargets.length; i++) {
      const { tokenID, question, category } = allTargets[i];
      console.log(`  ${i + 1}. [${category}] "${question}" token=${tokenID.slice(0, 16)}...`);
    }
    await exportDryRunTargets(allTargets);
    console.log();
    console.log("=== DRY RUN 汇总 ===");
    console.log(`唯一目标数: ${allTargets.length}`);
    console.log(`预估成本: ${allTargets.length * config.ORDER_PRICE * config.ORDER_SIZE} USDC`);
    logCategorySummary(categoryCounts, excludedCounts);
    return;
  }

  // Check circuit breaker
  if (circuitBreaker.isPaused()) {
    console.warn("[RISK] 熔断器已触发，跳过本轮买入扫描");
    return;
  }

  const openOrderSnapshot = await getAccountOpenOrders(client);
  const activeTrackedTokenIDs = getActiveTrackedTokenIDs(state);
  if (activeTrackedTokenIDs.size > 0) {
    console.log(`[State] 当前在 ${config.STATE_FILE} 中追踪 ${activeTrackedTokenIDs.size} 个活跃 token`);
  }

  const blockedTokenIDs = unionSets(
    openOrderSnapshot.tokenIDs,
    activeTrackedTokenIDs,
    pendingTokenIDs
  );
  const targets = allTargets.filter((target) => !blockedTokenIDs.has(target.tokenID));

  const dedupSkipped = allTargets.length - targets.length;
  if (dedupSkipped > 0) {
    console.log(`[Dedup] 跳过 ${dedupSkipped} 个市场（已存在挂单或已在追踪中）`);
  }
  console.log();

  // Phase 4: Place orders
  console.log("--- 阶段 4: 执行下单 ---");
  let success = 0;
  let failed = 0;
  let skippedCount = 0;
  const batchSize = Math.max(1, config.ORDER_BATCH_SIZE);
  const batches = chunkArray(targets, batchSize);
  let stopRequested = false;

  // PLACEHOLDER_BUY_BATCHES

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    if (stopRequested) break;

    const batch = batches[batchIndex];
    console.log(`[批次 ${batchIndex + 1}/${batches.length}] 正在处理 ${batch.length} 个目标`);

    for (let i = 0; i < batch.length; i++) {
      const absoluteIndex = batchIndex * batchSize + i;
      const { question, category } = batch[i];
      console.log(`[${absoluteIndex + 1}/${targets.length}] [${category}] "${question}"`);
    }

    let results;
    for (const target of batch) {
      pendingTokenIDs.add(target.tokenID);
    }
    try {
      results = await placeOrdersBatch(client, batch);
    } finally {
      for (const target of batch) {
        pendingTokenIDs.delete(target.tokenID);
      }
    }

    let stateChanged = false;

    for (let i = 0; i < batch.length; i++) {
      const target = batch[i];
      const result = results[i];
      const { tokenID, question, category } = target;

      if (result.success) {
        success++;
        const orderID = result.result?.orderID || null;
        upsertToken(state, tokenID, {
          question,
          category,
          slug: target.slug,
          state: States.CANDIDATE,
        });
        await transitionToken(state, tokenID, States.BUY_OPEN, { buyOrderId: orderID });
        circuitBreaker.recordSuccess();
        stateChanged = true;
        continue;
      }

      if (result.skipped) {
        skippedCount++;
        continue;
      }

      failed++;
      circuitBreaker.recordError();
      await appendOrderErrorLog({
        timestamp: new Date().toISOString(),
        iteration,
        question,
        category,
        tokenID,
        error: result.error || "未知错误",
        stopAll: Boolean(result.stopAll),
      });

      if (result.stopAll) {
        stopRequested = true;
      }
    }

    if (stateChanged) {
      await saveState(config.STATE_FILE, state);
    }

    if (stopRequested) {
      console.error("[STOP] 下单前置条件出现致命错误，终止剩余批次。");
      break;
    }

    if (batchIndex < batches.length - 1) {
      await sleep(config.ORDER_DELAY_MS);
    }
  }

  console.log();
  console.log("=== 买入汇总 ===");
  console.log(`目标总数: ${allTargets.length}`);
  console.log(`跳过（去重/风控）: ${dedupSkipped}`);
  console.log(`跳过（盘口检查）: ${skippedCount}`);
  console.log(`下单成功: ${success}`);
  console.log(`下单失败: ${failed}`);
  logCategorySummary(categoryCounts, excludedCounts);
}
