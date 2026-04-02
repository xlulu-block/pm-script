import { initClobClient } from "./clob.js";
import { config } from "./config.js";
import { getFilledShares, placeSellOrder } from "./orders.js";
import { getAllTokenIDs, loadState } from "./state.js";
import { inspectBatchOrderBooks } from "./clob.js";

const SELL_ALL_PRICE = 0.001;
const BALANCE_DISCOVERY_CONCURRENCY = 8;
const ORDERBOOK_BATCH_SIZE = 25;
const CANCEL_BATCH_SIZE = 50;

function chunkArray(items, size) {
  const batchSize = Math.max(1, size);
  const chunks = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

function takeUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function decimalPlaces(value) {
  const text = String(value ?? "").trim();
  if (!text.includes(".")) return 0;
  return text.split(".")[1].length;
}

function isPriceCompatibleWithTickSize(price, tickSize) {
  const tick = Number(tickSize);
  const targetPrice = Number(price);
  if (!Number.isFinite(tick) || tick <= 0) return false;
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return false;

  const scale = 10 ** Math.max(decimalPlaces(price), decimalPlaces(tickSize));
  const scaledPrice = Math.round(targetPrice * scale);
  const scaledTick = Math.round(tick * scale);
  if (scaledTick <= 0) return false;

  return scaledPrice % scaledTick === 0;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
  return results;
}

async function loadCandidateTokenIDs(openOrders, trades) {
  const state = await loadState(config.STATE_FILE);
  const stateTokenIDs = [...getAllTokenIDs(state)];
  const openOrderTokenIDs = Array.isArray(openOrders)
    ? openOrders.map((order) => order?.asset_id || order?.tokenID || null)
    : [];
  const tradeTokenIDs = Array.isArray(trades)
    ? trades.map((trade) => trade?.asset_id || null)
    : [];

  const tokenIDs = takeUnique([
    ...stateTokenIDs,
    ...openOrderTokenIDs,
    ...tradeTokenIDs,
  ]);

  console.log(
    `[SELL-ALL] 候选 token ID 数量: ${tokenIDs.length}（state=${stateTokenIDs.length}, openOrders=${takeUnique(openOrderTokenIDs).length}, trades=${takeUnique(tradeTokenIDs).length}）`
  );

  return tokenIDs;
}

async function cancelAllOpenSellOrders(client, openOrders) {
  const sellOrderIDs = (Array.isArray(openOrders) ? openOrders : [])
    .filter((order) => String(order?.side || "").toUpperCase() === "SELL")
    .map((order) => order?.id)
    .filter(Boolean);

  if (sellOrderIDs.length === 0) {
    console.log("[SELL-ALL] 当前没有需要取消的 SELL 挂单");
    return { success: true, cancelledCount: 0 };
  }

  console.log(`[SELL-ALL] 正在取消 ${sellOrderIDs.length} 笔 SELL 挂单...`);
  for (const [index, batch] of chunkArray(sellOrderIDs, CANCEL_BATCH_SIZE).entries()) {
    await client.cancelOrders(batch);
    console.log(
      `[SELL-ALL] 已完成 SELL 订单取消批次 ${index + 1}/${Math.ceil(sellOrderIDs.length / CANCEL_BATCH_SIZE)}`
    );
  }

  const remainingOrders = await client.getOpenOrders();
  const remainingSellOrders = Array.isArray(remainingOrders)
    ? remainingOrders.filter((order) => String(order?.side || "").toUpperCase() === "SELL")
    : [];

  if (remainingSellOrders.length > 0) {
    console.error(`[SELL-ALL] 取消后仍残留 ${remainingSellOrders.length} 笔 SELL 订单`);
    return {
      success: false,
      cancelledCount: sellOrderIDs.length - remainingSellOrders.length,
      remainingCount: remainingSellOrders.length,
    };
  }

  console.log("[SELL-ALL] 所有 SELL 挂单都已取消");
  return { success: true, cancelledCount: sellOrderIDs.length, remainingCount: 0 };
}

async function loadPositiveBalances(client, tokenIDs) {
  if (tokenIDs.length === 0) return [];

  const balances = await mapWithConcurrency(
    tokenIDs,
    BALANCE_DISCOVERY_CONCURRENCY,
    async (tokenID, index) => {
      if (index === 0 || (index + 1) % 25 === 0 || index === tokenIDs.length - 1) {
        console.log(`[SELL-ALL] 余额扫描进度: ${index + 1}/${tokenIDs.length}`);
      }

      return {
        tokenID,
        balance: await getFilledShares(client, tokenID),
      };
    }
  );

  return balances.filter((entry) => entry.balance > 0);
}

async function inspectOrderBooksForBalances(client, balances) {
  const bookByTokenID = new Map();
  const workItems = balances.map(({ tokenID }) => ({ target: { tokenID } }));
  const batches = chunkArray(workItems, ORDERBOOK_BATCH_SIZE);

  for (let i = 0; i < batches.length; i++) {
    console.log(`[SELL-ALL] 盘口扫描进度: ${i + 1}/${batches.length}`);
    const currentMap = await inspectBatchOrderBooks(client, batches[i]);
    for (const [tokenID, orderBook] of currentMap.entries()) {
      bookByTokenID.set(tokenID, orderBook);
    }
  }

  return bookByTokenID;
}

async function main() {
  console.log("=== 一键卖出全部持仓 ===");
  console.log(`[SELL-ALL] 目标价格: ${SELL_ALL_PRICE.toFixed(3)}`);

  const client = await initClobClient({
    ensureCollateral: false,
    refreshCollateralCache: false,
  });

  const [openOrders, trades] = await Promise.all([
    client.getOpenOrders(),
    client.getTrades(),
  ]);

  const candidateTokenIDs = await loadCandidateTokenIDs(openOrders, trades);
  const cancelResult = await cancelAllOpenSellOrders(client, openOrders);
  if (!cancelResult.success) {
    throw new Error("未能清理所有现有 SELL 订单，终止 sell-all 流程。");
  }

  const balances = await loadPositiveBalances(client, candidateTokenIDs);
  if (balances.length === 0) {
    console.log("[SELL-ALL] 没有发现正余额持仓");
    return;
  }

  console.log(`[SELL-ALL] 正余额 token 数量: ${balances.length}`);
  const bookByTokenID = await inspectOrderBooksForBalances(client, balances);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const { tokenID, balance } of balances) {
    const orderBook = bookByTokenID.get(tokenID);
    if (!orderBook) {
      skipped++;
      console.warn(`[SELL-ALL] 跳过 ${tokenID.slice(0, 12)}...: 无法获取盘口`);
      continue;
    }

    if (orderBook.tick_size && !isPriceCompatibleWithTickSize(SELL_ALL_PRICE, orderBook.tick_size)) {
      skipped++;
      console.warn(
        `[SELL-ALL] 跳过 ${tokenID.slice(0, 12)}...: tick size ${orderBook.tick_size} 与价格 ${SELL_ALL_PRICE.toFixed(3)} 不兼容`
      );
      continue;
    }

    const result = await placeSellOrder(client, tokenID, SELL_ALL_PRICE, balance, {
      tickSize: orderBook.tick_size,
      negRisk: orderBook.neg_risk,
    });

    if (result.success) {
      success++;
    } else {
      failed++;
    }
  }

  console.log();
  console.log("=== 全量卖出汇总 ===");
  console.log(`候选 token ID 数量: ${candidateTokenIDs.length}`);
  console.log(`正余额数量: ${balances.length}`);
  console.log(`已取消 SELL 订单数: ${cancelResult.cancelledCount}`);
  console.log(`SELL 下单成功数: ${success}`);
  console.log(`SELL 下单失败数: ${failed}`);
  console.log(`跳过的持仓数: ${skipped}`);
}

main().catch((err) => {
  console.error("[SELL-ALL:FATAL] 程序异常退出:", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[SELL-ALL:CAUSE] 原因: ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
