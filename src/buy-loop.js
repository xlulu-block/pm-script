import { appendFile, writeFile } from "node:fs/promises";
import { config } from "./config.js";
import { fetchAllActiveMarkets } from "./gamma.js";
import { filterMarkets } from "./filters.js";
import {
  initClobClient,
  getBoughtTokenIDs,
  getExistingOrderTokenIDs,
  placeOrdersBatch,
} from "./clob.js";
import {
  getAllTokenIDs,
  getToken,
  loadState,
  saveState,
  upsertToken,
  transitionToken,
  getTokensByState,
} from "./state.js";
import { States, TERMINAL_STATES, acquireTokenLock } from "./state-machine.js";

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
      console.log(`EXCLUDED_${key.toUpperCase()}: ${count}`);
    }
  }
}

async function appendOrderErrorLog(entry) {
  const payload = `${JSON.stringify(entry)}\n`;
  await appendFile(config.ERROR_LOG_FILE, payload, "utf8");
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
  console.log(`[DRY RUN] Exported targets to ${jsonPath} and ${txtPath}`);
}

export async function runBuyScan(client, state, iteration, pendingTokenIDs, circuitBreaker) {
  console.log("=== Buy Scan ===");
  console.log(
    `Price: ${config.ORDER_PRICE}, Size: ${config.ORDER_SIZE}, DRY_RUN: ${config.DRY_RUN}, Iteration: ${iteration}`
  );
  console.log();

  // Phase 1: Discover
  console.log("--- Phase 1: DISCOVER ---");
  const markets = await fetchAllActiveMarkets();
  console.log();

  // Phase 2: Filter
  console.log("--- Phase 2: FILTER ---");
  const { categoryCounts, excludedCounts, allTargets } = filterMarkets(markets);

  if (allTargets.length === 0) {
    console.log("[Done] No matching markets found.");
    return;
  }
  console.log();

  // Phase 3: Dedup + Auth
  console.log("--- Phase 3: AUTH & DEDUP ---");
  const stateTokenIDs = getAllTokenIDs(state);
  if (stateTokenIDs.size > 0) {
    console.log(`[State] Loaded ${stateTokenIDs.size} historical token IDs from ${config.STATE_FILE}`);
  }

  if (config.DRY_RUN) {
    console.log("[DRY RUN] Skipping auth and order placement");
    console.log();
    console.log("--- DRY RUN: Would place orders on these markets ---");
    for (let i = 0; i < allTargets.length; i++) {
      const { tokenID, question, category } = allTargets[i];
      console.log(`  ${i + 1}. [${category}] "${question}" token=${tokenID.slice(0, 16)}...`);
    }
    await exportDryRunTargets(allTargets);
    console.log();
    console.log("=== DRY RUN SUMMARY ===");
    console.log(`Unique targets: ${allTargets.length}`);
    console.log(`Estimated cost: ${allTargets.length * config.ORDER_PRICE * config.ORDER_SIZE} USDC`);
    logCategorySummary(categoryCounts, excludedCounts);
    return;
  }

  // Check circuit breaker
  if (circuitBreaker.isPaused()) {
    console.warn("[RISK] Circuit breaker is active — skipping buy scan");
    return;
  }

  const existingOrderTokenIDs = await getExistingOrderTokenIDs(client);
  const boughtTokenIDs = await getBoughtTokenIDs(client);

  // Sync bought tokens into state
  for (const tokenID of boughtTokenIDs) {
    const existing = getToken(state, tokenID);
    if (!existing) {
      upsertToken(state, tokenID, { state: States.FILLED_WAIT_SELL });
    }
  }
  await saveState(config.STATE_FILE, state);

  // Build blocked set: anything already in state (non-terminal), existing orders, bought, pending
  const nonTerminalTokenIDs = new Set(
    Object.values(state.tokens)
      .filter((t) => !TERMINAL_STATES.has(t.state))
      .map((t) => t.tokenID)
  );
  const blockedTokenIDs = unionSets(existingOrderTokenIDs, boughtTokenIDs, nonTerminalTokenIDs, pendingTokenIDs);

  let targets = allTargets.filter((target) => !blockedTokenIDs.has(target.tokenID));

  const dedupSkipped = allTargets.length - targets.length;
  if (dedupSkipped > 0) {
    console.log(`[Dedup] Skipping ${dedupSkipped} markets (already tracked or open)`);
  }
  console.log();

  // Phase 4: Place orders
  console.log("--- Phase 4: PLACE ORDERS ---");
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
    console.log(`[Batch ${batchIndex + 1}/${batches.length}] Processing ${batch.length} target(s)`);

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
        error: result.error || "Unknown error",
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
      console.error("[STOP] Fatal order precondition failed - aborting remaining batches.");
      break;
    }

    if (batchIndex < batches.length - 1) {
      await sleep(config.ORDER_DELAY_MS);
    }
  }

  console.log();
  console.log("=== BUY SUMMARY ===");
  console.log(`Total targets: ${allTargets.length}`);
  console.log(`Skipped (dedup/risk): ${dedupSkipped}`);
  console.log(`Skipped (order book): ${skippedCount}`);
  console.log(`Placed: ${success}`);
  console.log(`Failed: ${failed}`);
  logCategorySummary(categoryCounts, excludedCounts);
}
