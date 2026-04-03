import { config } from "./config.js";
import { States, acquireTokenLock } from "./state-machine.js";
import {
  getTokensByState,
  transitionToken,
  saveState,
  getToken,
  pruneTerminalTokens,
  upsertToken,
  getActiveTrackedTokens,
} from "./state.js";
import {
  analyzeBidDepth,
  decideSellPrice,
  formatPrice,
  getBuyPriceLevel,
  getDepthThreshold,
  getTargetSellPrice,
  shouldForceExit,
} from "./depth.js";
import {
  cancelOrdersForToken,
  placeSellOrder,
  getFilledShares,
} from "./orders.js";
import {
  getAccountOpenOrders,
  getBoughtTokenIDs,
  getOpenOrdersForTokenFromSnapshot,
  inspectBatchOrderBooks,
} from "./clob.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BALANCE_DISCOVERY_CONCURRENCY = 8;

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

function getSellScanConcurrency() {
  return Math.max(1, Number(config.SELL_SCAN_CONCURRENCY || BALANCE_DISCOVERY_CONCURRENCY));
}

function createProgressReporter(label, total, step = config.SELL_PROGRESS_STEP) {
  if (total <= 0) return () => {};

  const normalizedStep = Math.max(1, Number(step) || 1);
  const effectiveStep = total <= normalizedStep ? total : normalizedStep;
  let completed = 0;

  return () => {
    completed += 1;
    if (completed === 1 || completed === total || completed % effectiveStep === 0) {
      console.log(`[SELL] ${label}: ${completed}/${total}`);
    }
  };
}

async function withTokenLock(tokenID, worker) {
  const lock = acquireTokenLock(tokenID);
  await lock.wait;
  try {
    return await worker();
  } finally {
    lock.release();
  }
}

async function runTokenStage(items, label, worker) {
  if (items.length === 0) return;

  const reportProgress = createProgressReporter(label, items.length);
  await mapWithConcurrency(items, getSellScanConcurrency(), async (item, index) => {
    try {
      await worker(item, index);
    } finally {
      reportProgress();
    }
  });
}

function inferTrackedState(balance, orderSnapshot) {
  if (orderSnapshot.sellOrders.length > 0) {
    const sellOrderInfo = inspectSellOrders(orderSnapshot.sellOrders);
    if (sellOrderInfo.hasSellAtBuyPrice) return States.SELL_OPEN_001;
    return States.SELL_OPEN_002;
  }

  if (orderSnapshot.buyOrders.length > 0) {
    return balance > 0 ? States.PARTIAL_FILL : States.BUY_OPEN;
  }

  if (balance > 0) {
    return States.FILLED_WAIT_SELL;
  }

  return null;
}

function inferTrackedSellPrice(orderSnapshot) {
  const sellOrderInfo = inspectSellOrders(orderSnapshot.sellOrders);
  if (sellOrderInfo.hasSellAtBuyPrice) return getBuyPriceLevel(config);
  if (sellOrderInfo.hasSellAtTargetPrice) return getTargetSellPrice(config);
  return normalizeSellOrderPrice(orderSnapshot.sellOrders[0] || null);
}

async function syncStateWithAccount(client, state, openOrderSnapshot) {
  const activeTrackedTokens = getActiveTrackedTokens(state);
  const candidateTokenIDs = new Set([
    ...activeTrackedTokens.map((token) => token.tokenID),
    ...openOrderSnapshot.tokenIDs,
  ]);

  if (candidateTokenIDs.size === 0) {
    console.log("[SELL] 当前没有活跃追踪 token 或挂单，正在从 BUY 交易历史发现候选持仓...");
    const boughtTokenIDs = await getBoughtTokenIDs(client);
    for (const tokenID of boughtTokenIDs) {
      candidateTokenIDs.add(tokenID);
    }
  }

  if (candidateTokenIDs.size === 0) {
    return;
  }

  const tokenIDs = [...candidateTokenIDs];
  console.log(`[SELL] 正在同步账户库存，候选 token 数量: ${tokenIDs.length}...`);
  const reportProgress = createProgressReporter("库存同步进度", tokenIDs.length);

  const balances = await mapWithConcurrency(
    tokenIDs,
    getSellScanConcurrency(),
    async (tokenID) => {
      try {
        return {
          tokenID,
          balance: await getFilledShares(client, tokenID),
        };
      } finally {
        reportProgress();
      }
    }
  );

  let addedCount = 0;

  for (const { tokenID, balance } of balances) {
    const orderSnapshot = getOpenOrdersForTokenFromSnapshot(openOrderSnapshot, tokenID);
    const heldShares = getHeldShares(balance, orderSnapshot.sellOrders);
    const nextState = inferTrackedState(heldShares, orderSnapshot);
    const existing = getToken(state, tokenID);

    if (!nextState) {
      continue;
    }

    const fields = {
      state: nextState,
      buyOrderId: orderSnapshot.buyOrders[0]?.id || null,
      sellOrderId: orderSnapshot.sellOrders[0]?.id || null,
      sellPrice: inferTrackedSellPrice(orderSnapshot),
      filledShares: heldShares,
      lastError: null,
    };

    if (existing) {
      Object.assign(existing, fields);
      continue;
    }

    upsertToken(state, tokenID, fields);
    addedCount++;
  }

  if (addedCount > 0) {
    console.log(`[SELL] 已从账户快照补充 ${addedCount} 个在线 token`);
  }
}

export async function runSellScan(client, state) {
  console.log("[SELL] 开始卖出扫描...");

  const initialOpenOrderSnapshot = await getAccountOpenOrders(client);
  await syncStateWithAccount(client, state, initialOpenOrderSnapshot);

  await recoverDustBalances(client, state);
  await processSellableTokens(client, state, initialOpenOrderSnapshot);

  const finalOpenOrderSnapshot = await getAccountOpenOrders(client);
  await checkSellOrderStatuses(client, state, finalOpenOrderSnapshot);
  await checkBuyOrderStatuses(client, state, finalOpenOrderSnapshot);

  const prunedCount = pruneTerminalTokens(state);
  if (prunedCount > 0) {
    console.log(`[SELL] 已从本地状态中清理 ${prunedCount} 个终态 token`);
  }

  await saveState(config.STATE_FILE, state);
  console.log("[SELL] 卖出扫描完成。");
}

function normalizeSellOrderPrice(order) {
  const rawPrice = order?.price ?? order?.limit_price ?? order?.original_price ?? null;
  return formatPrice(rawPrice);
}

function getRemainingOrderSize(order) {
  const originalSize = Number(order?.original_size ?? order?.size ?? 0);
  const matchedSize = Number(order?.size_matched || 0);
  if (!Number.isFinite(originalSize) || !Number.isFinite(matchedSize)) return null;
  return Math.max(0, originalSize - matchedSize);
}

function getTotalOpenSellSize(sellOrders) {
  return sellOrders.reduce((total, order) => {
    const remainingSize = getRemainingOrderSize(order);
    return total + (remainingSize ?? 0);
  }, 0);
}

function getHeldShares(balance, sellOrders) {
  const availableBalance = Number(balance || 0);
  const normalizedAvailableBalance = Number.isFinite(availableBalance) ? Math.max(0, availableBalance) : 0;
  return normalizedAvailableBalance + getTotalOpenSellSize(sellOrders);
}

function getOpenBuySizeAtBuyPrice(buyOrders) {
  const buyPrice = getBuyPriceLevel(config);
  return buyOrders.reduce((total, order) => {
    if (normalizeSellOrderPrice(order) !== buyPrice) return total;
    const remainingSize = getRemainingOrderSize(order);
    return total + (remainingSize ?? 0);
  }, 0);
}

function hasOnlyBuyOrdersAtBuyPrice(buyOrders) {
  if (buyOrders.length === 0) return false;

  const buyPrice = getBuyPriceLevel(config);
  return buyOrders.every((order) => normalizeSellOrderPrice(order) === buyPrice);
}

function isSizeAligned(orderSize, balance) {
  return Math.abs(orderSize - balance) < 1e-6;
}

function inspectSellOrders(sellOrders) {
  const buyPrice = getBuyPriceLevel(config);
  const targetSellPrice = getTargetSellPrice(config);
  const result = {
    hasSellAtBuyPrice: false,
    hasSellAtTargetPrice: false,
    firstSellAtBuyPrice: null,
    firstSellAtTargetPrice: null,
  };

  for (const order of sellOrders) {
    const price = normalizeSellOrderPrice(order);
    if (price === buyPrice) {
      result.hasSellAtBuyPrice = true;
      result.firstSellAtBuyPrice ||= order;
    } else if (price === targetSellPrice) {
      result.hasSellAtTargetPrice = true;
      result.firstSellAtTargetPrice ||= order;
    }
  }

  return result;
}

function getSellStateForPrice(price) {
  return price === getBuyPriceLevel(config) ? States.SELL_OPEN_001 : States.SELL_OPEN_002;
}

function getReplaceCooldownRemainingMs(token) {
  const cooldownMs = Number(config.REPLACE_COOLDOWN_MS || 0);
  if (cooldownMs <= 0) return 0;

  const lastActionAt = Date.parse(token?.lastActionAt || "");
  if (!Number.isFinite(lastActionAt)) return 0;

  return Math.max(0, cooldownMs - (Date.now() - lastActionAt));
}

async function syncTrackedSell(state, token, balance, sellOrderId, sellPrice) {
  const fields = {
    buyOrderId: null,
    sellOrderId: sellOrderId || token.sellOrderId || null,
    sellPrice,
    filledShares: balance,
  };

  const targetState = getSellStateForPrice(sellPrice);
  if (token.state === targetState) {
    const trackedToken = getToken(state, token.tokenID);
    if (trackedToken) Object.assign(trackedToken, fields);
    return;
  }

  await transitionToken(state, token.tokenID, targetState, fields);
}

async function replaceTrackedSellOrder(
  client,
  state,
  token,
  orderBook,
  fromPrice,
  toPrice
) {
  console.log(`[SELL] 正在调整 ${token.question} 的卖价: ${fromPrice} -> ${toPrice}`);

  const cancelResult = await cancelOrdersForToken(client, token.tokenID, "SELL");
  if (!cancelResult.success) {
    console.warn(`[SELL] 调价时取消 ${token.question} 的卖单失败`);
    return false;
  }

  const refreshedBalance = await getFilledShares(client, token.tokenID);
  if (refreshedBalance <= 0) {
    await transitionToken(state, token.tokenID, States.SOLD, {
      filledShares: 0,
      sellOrderId: null,
      sellPrice: null,
    });
    return true;
  }

  const result = await placeSellOrder(client, token.tokenID, toPrice, refreshedBalance, {
    tickSize: orderBook.tick_size,
    negRisk: orderBook.neg_risk,
  });
  if (!result.success) {
    await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
      sellOrderId: null,
      sellPrice: null,
      filledShares: refreshedBalance,
    });
    return false;
  }

  await syncTrackedSell(state, token, refreshedBalance, result.orderID, toPrice);
  return true;
}

async function forceClearMarket(client, state, token, orderBook, balance, buyOrders, sellOrders, reason) {
  const buyPrice = getBuyPriceLevel(config);
  const { hasSellAtBuyPrice, firstSellAtBuyPrice } = inspectSellOrders(sellOrders);
  const existingSellSize = firstSellAtBuyPrice ? getRemainingOrderSize(firstSellAtBuyPrice) : null;

  console.log(`[SELL] ${token.question} 触发清仓条件：${reason}，按 ${buyPrice} 清仓`);

  if (buyOrders.length > 0) {
    const buyCancelResult = await cancelOrdersForToken(client, token.tokenID, "BUY");
    if (!buyCancelResult.success) {
      console.warn(`[SELL] 清仓时取消 ${token.question} 的买单失败`);
      return;
    }
  }

  const freshBalance = buyOrders.length > 0
    ? getHeldShares(await getFilledShares(client, token.tokenID), sellOrders)
    : balance;
  if (freshBalance <= 0) {
    const terminalState = token.state === States.BUY_OPEN ? States.BUY_CLOSED_NO_FILL : States.DUST;
    await transitionToken(state, token.tokenID, terminalState, {
      buyOrderId: null,
      sellOrderId: null,
      sellPrice: null,
      filledShares: 0,
    });
    return;
  }

  if (token.state === States.BUY_OPEN) {
    await transitionToken(state, token.tokenID, States.PARTIAL_FILL, {
      filledShares: freshBalance,
      buyOrderId: null,
    });
    token = getToken(state, token.tokenID) || token;
  }

  if (
    hasSellAtBuyPrice &&
    sellOrders.length === 1 &&
    existingSellSize !== null &&
    isSizeAligned(existingSellSize, freshBalance)
  ) {
    await syncTrackedSell(
      state,
      token,
      freshBalance,
      firstSellAtBuyPrice?.id || null,
      buyPrice
    );
    return;
  }

  if (sellOrders.length > 0) {
    const cancelResult = await cancelOrdersForToken(client, token.tokenID, "SELL");
    if (!cancelResult.success) {
      console.warn(`[SELL] 清仓时取消 ${token.question} 的卖单失败`);
      return;
    }
  }

  const result = await placeSellOrder(client, token.tokenID, buyPrice, freshBalance, {
    tickSize: orderBook.tick_size,
    negRisk: orderBook.neg_risk,
  });
  if (result.success) {
    await syncTrackedSell(state, token, freshBalance, result.orderID, buyPrice);
    return;
  }

  await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
    buyOrderId: null,
    sellOrderId: null,
    sellPrice: null,
    filledShares: freshBalance,
  });
}

async function fetchOrderBookForToken(client, tokenID) {
  const books = await inspectBatchOrderBooks(client, [{ target: { tokenID } }]);
  return books.get(tokenID) || null;
}

function getNetForceExitReason(depth, threshold) {
  if (!depth.hasAnyBids) {
    return "no bids in book";
  }

  if (depth.bidSharesAtBuyPrice <= 0) {
    if (depth.excludedBidSharesAtBuyPrice > 0 && depth.observedBidSharesAtBuyPrice > 0) {
      return `no external ${depth.buyPriceLevel} bids after excluding own BUY size ${depth.excludedBidSharesAtBuyPrice}`;
    }
    return `no ${depth.buyPriceLevel} bids in book`;
  }

  if (depth.excludedBidSharesAtBuyPrice > 0) {
    return `${depth.buyPriceLevel} net bid depth (${depth.bidSharesAtBuyPrice}, observed ${depth.observedBidSharesAtBuyPrice}, own ${depth.excludedBidSharesAtBuyPrice}) below threshold ${threshold}`;
  }

  return `${depth.buyPriceLevel} bid depth (${depth.bidSharesAtBuyPrice}) below threshold ${threshold}`;
}

async function refreshBuyOrdersForDecision(client, tokenID, currentBuyOrders) {
  if (currentBuyOrders.length === 0) {
    return currentBuyOrders;
  }

  try {
    const openOrders = await client.getOpenOrders({ asset_id: tokenID });
    if (!Array.isArray(openOrders)) {
      return currentBuyOrders;
    }

    return openOrders.filter(
      (order) => String(order?.side || "").toUpperCase() === "BUY"
    );
  } catch (err) {
    console.warn(
      `[SELL] Failed to refresh BUY orders for ${tokenID.slice(0, 12)}...: ${err.message}`
    );
    return currentBuyOrders;
  }
}

async function confirmSellDecisionWithNetDepth(client, token, orderBook, buyOrders = []) {
  const shouldCheckBuyDepth = hasOnlyBuyOrdersAtBuyPrice(buyOrders);
  const initialDepth = analyzeBidDepth(
    orderBook,
    config,
    shouldCheckBuyDepth
      ? { excludeBidSizeAtBuyPrice: getOpenBuySizeAtBuyPrice(buyOrders) }
      : undefined
  );
  const initialTargetPrice = decideSellPrice(initialDepth, config);
  const initialForceExit = shouldCheckBuyDepth && shouldForceExit(initialDepth, config);

  if (!shouldCheckBuyDepth) {
    return {
      confirmed: true,
      orderBook,
      depth: initialDepth,
      targetPrice: initialTargetPrice,
      shouldForceExit: false,
    };
  }

  if (config.SELL_DEPTH_DEBOUNCE_MS <= 0) {
    return {
      confirmed: true,
      orderBook,
      depth: initialDepth,
      targetPrice: initialTargetPrice,
      shouldForceExit: initialForceExit,
    };
  }

  console.log(
    `[SELL] Debouncing sell decision for ${token.question} (${config.SELL_DEPTH_DEBOUNCE_MS}ms)`
  );
  await sleep(config.SELL_DEPTH_DEBOUNCE_MS);

  const refreshedBook = await fetchOrderBookForToken(client, token.tokenID);
  if (!refreshedBook) {
    return { confirmed: false, reason: "failed to refresh order book during sell debounce" };
  }

  const refreshedBuyOrders = await refreshBuyOrdersForDecision(
    client,
    token.tokenID,
    buyOrders
  );
  const refreshedShouldCheckBuyDepth = hasOnlyBuyOrdersAtBuyPrice(refreshedBuyOrders);
  const refreshedDepth = analyzeBidDepth(
    refreshedBook,
    config,
    refreshedShouldCheckBuyDepth
      ? { excludeBidSizeAtBuyPrice: getOpenBuySizeAtBuyPrice(refreshedBuyOrders) }
      : undefined
  );
  const refreshedTargetPrice = decideSellPrice(refreshedDepth, config);
  const refreshedForceExit =
    refreshedShouldCheckBuyDepth && shouldForceExit(refreshedDepth, config);
  if (
    shouldCheckBuyDepth !== refreshedShouldCheckBuyDepth ||
    initialForceExit !== refreshedForceExit ||
    initialTargetPrice !== refreshedTargetPrice
  ) {
    return {
      confirmed: false,
      reason: `sell signal changed during debounce (${initialTargetPrice} -> ${refreshedTargetPrice})`,
      orderBook: refreshedBook,
      depth: refreshedDepth,
    };
  }

  return {
    confirmed: true,
    orderBook: refreshedBook,
    depth: refreshedDepth,
    targetPrice: refreshedTargetPrice,
    shouldForceExit: refreshedForceExit,
  };
}

async function checkBuyOrderStatuses(client, state, openOrderSnapshot) {
  const buyTokens = getTokensByState(state, States.BUY_OPEN, States.PARTIAL_FILL);
  if (buyTokens.length === 0) return;

  console.log(`[SELL] 正在检查 ${buyTokens.length} 笔买单状态...`);

  await runTokenStage(buyTokens, "买单状态进度", async (token) => {
    await withTokenLock(token.tokenID, async () => {
      try {
        await checkSingleBuyOrder(client, state, token, openOrderSnapshot);
      } catch (err) {
        console.error(`[SELL] 检查买单 ${token.tokenID.slice(0, 12)}... 时出错: ${err.message}`);
        try {
          await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
        } catch {}
      }
    });
  });
}

async function recoverDustBalances(client, state) {
  const dustTokens = getTokensByState(state, States.DUST);
  if (dustTokens.length === 0) return;

  console.log(`[SELL] 正在检查 ${dustTokens.length} 个 dust token 是否恢复余额...`);

  await runTokenStage(dustTokens, "Dust 恢复进度", async (token) => {
    await withTokenLock(token.tokenID, async () => {
      try {
        const balance = await getFilledShares(client, token.tokenID);
        if (balance <= 0) {
          return;
        }

        console.log(`[SELL] ${token.question} 检测到余额恢复，正在从 dust 恢复，balance=${balance}`);
        await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
          filledShares: balance,
          buyOrderId: null,
          sellOrderId: null,
          sellPrice: null,
        });
      } catch (err) {
        console.error(`[SELL] 恢复 dust token ${token.tokenID.slice(0, 12)}... 时出错: ${err.message}`);
        try {
          await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
        } catch {}
      }
    });
  });
}

async function checkSingleBuyOrder(client, state, token, openOrderSnapshot) {
  const { buyOrders } = getOpenOrdersForTokenFromSnapshot(openOrderSnapshot, token.tokenID);
  const balance = await getFilledShares(client, token.tokenID);

  if (buyOrders.length === 0) {
    if (balance > 0) {
      console.log(`[SELL] ${token.question} 的买单已完成，balance=${balance}`);
      await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
        filledShares: balance,
        buyOrderId: null,
      });
    } else {
      console.log(`[SELL] ${token.question} 的买单已关闭且未成交`);
      await transitionToken(state, token.tokenID, States.BUY_CLOSED_NO_FILL, { buyOrderId: null });
    }
    return;
  }

  if (balance > 0 && token.state === States.BUY_OPEN) {
    console.log(`[SELL] ${token.question} 检测到部分成交，balance=${balance}`);
    await transitionToken(state, token.tokenID, States.PARTIAL_FILL, { filledShares: balance });
  } else if (balance > 0) {
    const trackedToken = getToken(state, token.tokenID);
    if (trackedToken) trackedToken.filledShares = balance;
  }
}

async function processSellableTokens(client, state, openOrderSnapshot) {
  const sellTokens = getTokensByState(
    state,
    States.BUY_OPEN,
    States.PARTIAL_FILL,
    States.FILLED_WAIT_SELL,
    States.SELL_OPEN_002,
    States.SELL_OPEN_001,
  );
  if (sellTokens.length === 0) return;

  console.log(`[SELL] 正在处理 ${sellTokens.length} 个 token 的卖出决策...`);

  await runTokenStage(sellTokens, "卖出决策进度", async (token) => {
    await withTokenLock(token.tokenID, async () => {
      try {
        await processSingleSellToken(client, state, token, openOrderSnapshot);
      } catch (err) {
        console.error(`[SELL] 处理卖出 ${token.tokenID.slice(0, 12)}... 时出错: ${err.message}`);
        try {
          await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
        } catch {}
      }
    });
  });
}

async function processSingleSellToken(client, state, token, openOrderSnapshot) {
  const { buyOrders, sellOrders } = getOpenOrdersForTokenFromSnapshot(openOrderSnapshot, token.tokenID);
  const balance = await getFilledShares(client, token.tokenID);
  const heldShares = getHeldShares(balance, sellOrders);
  let trackedToken = getToken(state, token.tokenID);
  if (trackedToken) trackedToken.filledShares = heldShares;
  const sellOrderInfo = inspectSellOrders(sellOrders);

  if (
    buyOrders.length === 0 &&
    heldShares > 0 &&
    (token.state === States.BUY_OPEN || token.state === States.PARTIAL_FILL)
  ) {
    console.log(`[SELL] ${token.question} 当前 balance=${balance} 且已无买单，提升为 filled_wait_sell`);
    await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
      filledShares: heldShares,
      buyOrderId: null,
    });
    token = getToken(state, token.tokenID) || token;
    trackedToken = getToken(state, token.tokenID) || trackedToken;
  }

  if (sellOrders.length > 0 && heldShares <= 0) {
    console.log(`[SELL] ${token.question || token.tokenID} 已无余额，正在取消陈旧卖单`);
    const cancelResult = await cancelOrdersForToken(client, token.tokenID, "SELL");
    if (cancelResult.success) {
      const terminalState =
        token.state === States.SELL_OPEN_001 || token.state === States.SELL_OPEN_002
          ? States.SOLD
          : States.DUST;
      await transitionToken(state, token.tokenID, terminalState, {
        filledShares: 0,
        sellOrderId: null,
        sellPrice: null,
      });
    }
    return;
  }

  if (buyOrders.length === 0 && sellOrders.length === 0 && heldShares <= 0) {
    const terminalState =
      token.state === States.BUY_OPEN
        ? States.BUY_CLOSED_NO_FILL
        : token.state === States.SELL_OPEN_001 || token.state === States.SELL_OPEN_002
          ? States.SOLD
          : States.DUST;
    await transitionToken(state, token.tokenID, terminalState, {
      filledShares: 0,
      buyOrderId: null,
      sellOrderId: null,
      sellPrice: null,
    });
    return;
  }

  let orderBook = null;
  try {
    orderBook = await fetchOrderBookForToken(client, token.tokenID);
  } catch (err) {
    console.warn(`[SELL] 获取 ${token.tokenID.slice(0, 12)}... 盘口失败: ${err.message}`);
    return;
  }

  if (!orderBook) {
    console.warn(`[SELL] ${token.tokenID.slice(0, 12)}... 没有可用盘口`);
    return;
  }

  const decision = await confirmSellDecisionWithNetDepth(client, token, orderBook, buyOrders);
  if (!decision.confirmed) {
    if (trackedToken && decision.depth) {
      trackedToken.lastSeenBidSharesAtOrderPrice = decision.depth.bidSharesAtBuyPrice;
    }
    console.log(`[SELL] 本轮跳过 ${token.question}: ${decision.reason}`);
    return;
  }

  const depth = decision.depth;
  const targetSellPrice = decision.targetPrice;
  if (trackedToken) trackedToken.lastSeenBidSharesAtOrderPrice = depth.bidSharesAtBuyPrice;

  if (buyOrders.length === 0 && heldShares > 0) {
    await forceClearMarket(
      client,
      state,
      token,
      decision.orderBook,
      heldShares,
      buyOrders,
      sellOrders,
      "no BUY orders remaining while holding shares"
    );
    return;
  }

  if (decision.shouldForceExit) {
    await forceClearMarket(
      client,
      state,
      token,
      decision.orderBook,
      heldShares,
      buyOrders,
      sellOrders,
      getNetForceExitReason(depth, getDepthThreshold(config))
    );
    return;
  }

  if (buyOrders.length > 0) {
    return;
  }

  if (sellOrders.length > 0) {
    if (
      sellOrderInfo.hasSellAtTargetPrice &&
      sellOrders.length === 1 &&
      isSizeAligned(getRemainingOrderSize(sellOrderInfo.firstSellAtTargetPrice), heldShares)
    ) {
      await syncTrackedSell(
        state,
        token,
        heldShares,
        sellOrderInfo.firstSellAtTargetPrice?.id || null,
        targetSellPrice
      );
    } else if (
      sellOrderInfo.hasSellAtBuyPrice &&
      sellOrders.length === 1 &&
      isSizeAligned(getRemainingOrderSize(sellOrderInfo.firstSellAtBuyPrice), heldShares)
    ) {
      const buyPrice = getBuyPriceLevel(config);
      const replaceCooldownRemainingMs = getReplaceCooldownRemainingMs(token);

      if (targetSellPrice !== buyPrice && replaceCooldownRemainingMs <= 0) {
        await replaceTrackedSellOrder(
          client,
          state,
          token,
          decision.orderBook,
          buyPrice,
          targetSellPrice
        );
      } else {
        if (targetSellPrice !== buyPrice && replaceCooldownRemainingMs > 0) {
          console.log(
            `[SELL] ${token.question} 深度已恢复，但调价冷却中，还需等待 ${replaceCooldownRemainingMs}ms`
          );
        }

        await syncTrackedSell(
          state,
          token,
          heldShares,
          sellOrderInfo.firstSellAtBuyPrice?.id || null,
          buyPrice
        );
      }
    }
    return;
  }

  const result = await placeSellOrder(client, token.tokenID, targetSellPrice, heldShares, {
    tickSize: decision.orderBook.tick_size,
    negRisk: decision.orderBook.neg_risk,
  });
  if (result.success) {
    await syncTrackedSell(state, token, heldShares, result.orderID, targetSellPrice);
  }
}

async function checkSellOrderStatuses(client, state, openOrderSnapshot) {
  const sellTokens = getTokensByState(state, States.SELL_OPEN_002, States.SELL_OPEN_001);
  if (sellTokens.length === 0) return;

  console.log(`[SELL] 正在检查 ${sellTokens.length} 笔 SELL 挂单状态...`);

  await runTokenStage(sellTokens, "卖单状态进度", async (token) => {
    await withTokenLock(token.tokenID, async () => {
      try {
        const { sellOrders } = getOpenOrdersForTokenFromSnapshot(openOrderSnapshot, token.tokenID);
        const balance = await getFilledShares(client, token.tokenID);
        const heldShares = getHeldShares(balance, sellOrders);
        const trackedToken = getToken(state, token.tokenID);
        if (trackedToken) trackedToken.filledShares = heldShares;

        if (sellOrders.length === 0 && heldShares <= 0) {
          console.log(`[SELL] ${token.question} 已全部卖出`);
          await transitionToken(state, token.tokenID, States.SOLD, {
            filledShares: 0,
            sellOrderId: null,
            sellPrice: null,
          });
        } else if (sellOrders.length === 0 && heldShares > 0) {
          console.log(`[SELL] ${token.question} 的卖单已消失，但余额仍在，balance=${balance}`);
          await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
            sellOrderId: null,
            filledShares: heldShares,
          });
        }
      } catch (err) {
        console.error(`[SELL] 检查卖单状态 ${token.tokenID.slice(0, 12)}... 时出错: ${err.message}`);
      }
    });
  });
}
