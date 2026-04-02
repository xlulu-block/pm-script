import { config } from "./config.js";
import { States, acquireTokenLock } from "./state-machine.js";
import {
  getTokensByState,
  transitionToken,
  saveState,
  getToken,
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
  getOpenOrdersForToken,
  getFilledShares,
} from "./orders.js";
import { inspectBatchOrderBooks } from "./clob.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSellScan(client, state) {
  console.log("[SELL] Starting sell scan...");

  await checkBuyOrderStatuses(client, state);
  await recoverDustBalances(client, state);
  await processSellableTokens(client, state);
  await checkSellOrderStatuses(client, state);

  await saveState(config.STATE_FILE, state);
  console.log("[SELL] Sell scan complete.");
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
  console.log(`[SELL] Repricing ${token.question} from ${fromPrice} to ${toPrice}`);

  const cancelResult = await cancelOrdersForToken(client, token.tokenID, "SELL");
  if (!cancelResult.success) {
    console.warn(`[SELL] Failed to cancel sell order for ${token.question} during repricing`);
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

  console.log(`[SELL] ${reason} for ${token.question}, clearing market at ${buyPrice}`);

  if (buyOrders.length > 0) {
    const buyCancelResult = await cancelOrdersForToken(client, token.tokenID, "BUY");
    if (!buyCancelResult.success) {
      console.warn(`[SELL] Failed to cancel buy orders for ${token.question} during clear-out`);
      return;
    }
  }

  const freshBalance = buyOrders.length > 0 ? await getFilledShares(client, token.tokenID) : balance;
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
      console.warn(`[SELL] Failed to cancel sell order for ${token.question} during clear-out`);
      return;
    }
  }

  const result = await placeSellOrder(client, token.tokenID, buyPrice, freshBalance, {
    tickSize: orderBook.tick_size,
    negRisk: orderBook.neg_risk,
  });
  if (result.success) {
    await syncTrackedSell(state, token, freshBalance, result.orderID, buyPrice);
  }
}

async function fetchOrderBookForToken(client, tokenID) {
  const books = await inspectBatchOrderBooks(client, [{ target: { tokenID } }]);
  return books.get(tokenID) || null;
}

function getForceExitReason(depth, threshold) {
  if (!depth.hasAnyBids) {
    return "No bids in order book";
  }
  if (depth.bidSharesAtBuyPrice <= 0) {
    return `No ${depth.buyPriceLevel} bids in order book`;
  }
  return `Bid depth at ${depth.buyPriceLevel} (${depth.bidSharesAtBuyPrice}) below threshold ${threshold}`;
}

async function confirmSellDecision(client, token, orderBook) {
  const initialDepth = analyzeBidDepth(orderBook, config);
  const initialTargetPrice = decideSellPrice(initialDepth, config);
  const initialForceExit = shouldForceExit(initialDepth, config);

  if (config.SELL_DEPTH_DEBOUNCE_MS <= 0) {
    return {
      confirmed: true,
      orderBook,
      depth: initialDepth,
      targetPrice: initialTargetPrice,
      shouldForceExit: initialForceExit,
    };
  }

  console.log(`[SELL] Debouncing sell decision for ${token.question} by ${config.SELL_DEPTH_DEBOUNCE_MS}ms`);
  await sleep(config.SELL_DEPTH_DEBOUNCE_MS);

  const refreshedBook = await fetchOrderBookForToken(client, token.tokenID);
  if (!refreshedBook) {
    return { confirmed: false, reason: "order book unavailable during debounce" };
  }

  const refreshedDepth = analyzeBidDepth(refreshedBook, config);
  const refreshedTargetPrice = decideSellPrice(refreshedDepth, config);
  const refreshedForceExit = shouldForceExit(refreshedDepth, config);
  if (
    initialForceExit !== refreshedForceExit ||
    initialTargetPrice !== refreshedTargetPrice
  ) {
    return {
      confirmed: false,
      reason: `unstable sell signal (${initialTargetPrice} -> ${refreshedTargetPrice})`,
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

async function checkBuyOrderStatuses(client, state) {
  const buyTokens = getTokensByState(state, States.BUY_OPEN, States.PARTIAL_FILL);
  if (buyTokens.length === 0) return;

  console.log(`[SELL] Checking ${buyTokens.length} buy order(s)...`);

  for (const token of buyTokens) {
    const lock = acquireTokenLock(token.tokenID);
    await lock.wait;
    try {
      await checkSingleBuyOrder(client, state, token);
    } catch (err) {
      console.error(`[SELL] Error checking buy order for ${token.tokenID.slice(0, 12)}...: ${err.message}`);
      try {
        await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
      } catch {}
    } finally {
      lock.release();
    }
  }
}

async function recoverDustBalances(client, state) {
  const dustTokens = getTokensByState(state, States.DUST);
  if (dustTokens.length === 0) return;

  for (const token of dustTokens) {
    const lock = acquireTokenLock(token.tokenID);
    await lock.wait;
    try {
      const balance = await getFilledShares(client, token.tokenID);
      if (balance <= 0) {
        continue;
      }

      console.log(`[SELL] Recovering dust state for ${token.question}, balance=${balance}`);
      await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
        filledShares: balance,
        buyOrderId: null,
        sellOrderId: null,
        sellPrice: null,
      });
    } catch (err) {
      console.error(`[SELL] Error recovering dust token ${token.tokenID.slice(0, 12)}...: ${err.message}`);
      try {
        await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
      } catch {}
    } finally {
      lock.release();
    }
  }
}

async function checkSingleBuyOrder(client, state, token) {
  const { buyOrders } = await getOpenOrdersForToken(client, token.tokenID);
  const balance = await getFilledShares(client, token.tokenID);

  if (buyOrders.length === 0) {
    if (balance > 0) {
      console.log(`[SELL] Buy order completed for ${token.question}, balance=${balance}`);
      await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
        filledShares: balance,
        buyOrderId: null,
      });
    } else {
      console.log(`[SELL] Buy order closed without fill for ${token.question}`);
      await transitionToken(state, token.tokenID, States.BUY_CLOSED_NO_FILL, { buyOrderId: null });
    }
    return;
  }

  if (balance > 0 && token.state === States.BUY_OPEN) {
    console.log(`[SELL] Partial fill detected for ${token.question}, balance=${balance}`);
    await transitionToken(state, token.tokenID, States.PARTIAL_FILL, { filledShares: balance });
  } else if (balance > 0) {
    const trackedToken = getToken(state, token.tokenID);
    if (trackedToken) trackedToken.filledShares = balance;
  }
}

async function processSellableTokens(client, state) {
  const sellTokens = getTokensByState(
    state,
    States.BUY_OPEN,
    States.PARTIAL_FILL,
    States.FILLED_WAIT_SELL,
    States.SELL_OPEN_002,
    States.SELL_OPEN_001,
  );
  if (sellTokens.length === 0) return;

  console.log(`[SELL] Processing ${sellTokens.length} token(s) for sell decisions...`);

  for (const token of sellTokens) {
    const lock = acquireTokenLock(token.tokenID);
    await lock.wait;
    try {
      await processSingleSellToken(client, state, token);
    } catch (err) {
      console.error(`[SELL] Error processing sell for ${token.tokenID.slice(0, 12)}...: ${err.message}`);
      try {
        await transitionToken(state, token.tokenID, States.ERROR_PAUSE, { lastError: err.message });
      } catch {}
    } finally {
      lock.release();
    }
  }
}

async function processSingleSellToken(client, state, token) {
  const balance = await getFilledShares(client, token.tokenID);
  const trackedToken = getToken(state, token.tokenID);
  if (trackedToken) trackedToken.filledShares = balance;

  const { buyOrders, sellOrders } = await getOpenOrdersForToken(client, token.tokenID);
  const sellOrderInfo = inspectSellOrders(sellOrders);

  if (buyOrders.length === 0 && sellOrders.length === 0) {
    if (balance <= 0) {
      return;
    }
  }

  let orderBook = null;
  try {
    orderBook = await fetchOrderBookForToken(client, token.tokenID);
  } catch (err) {
    console.warn(`[SELL] Order book fetch failed for ${token.tokenID.slice(0, 12)}...: ${err.message}`);
    return;
  }

  if (!orderBook) {
    console.warn(`[SELL] No order book for ${token.tokenID.slice(0, 12)}...`);
    return;
  }

  const decision = await confirmSellDecision(client, token, orderBook);
  if (!decision.confirmed) {
    if (trackedToken && decision.depth) {
      trackedToken.lastSeenBidSharesAtOrderPrice = decision.depth.bidSharesAtBuyPrice;
    }
    console.log(`[SELL] Skipping ${token.question} this round: ${decision.reason}`);
    return;
  }

  const depth = decision.depth;
  const targetSellPrice = decision.targetPrice;
  if (trackedToken) trackedToken.lastSeenBidSharesAtOrderPrice = depth.bidSharesAtBuyPrice;

  if (decision.shouldForceExit) {
    await forceClearMarket(
      client,
      state,
      token,
      decision.orderBook,
      balance,
      buyOrders,
      sellOrders,
      getForceExitReason(depth, getDepthThreshold(config))
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
      isSizeAligned(getRemainingOrderSize(sellOrderInfo.firstSellAtTargetPrice), balance)
    ) {
      await syncTrackedSell(
        state,
        token,
        balance,
        sellOrderInfo.firstSellAtTargetPrice?.id || null,
        targetSellPrice
      );
    } else if (
      sellOrderInfo.hasSellAtBuyPrice &&
      sellOrders.length === 1 &&
      isSizeAligned(getRemainingOrderSize(sellOrderInfo.firstSellAtBuyPrice), balance)
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
            `[SELL] ${token.question} recovered but repricing is cooling down for ${replaceCooldownRemainingMs}ms`
          );
        }

        await syncTrackedSell(
          state,
          token,
          balance,
          sellOrderInfo.firstSellAtBuyPrice?.id || null,
          buyPrice
        );
      }
    }
    return;
  }

  const result = await placeSellOrder(client, token.tokenID, targetSellPrice, balance, {
    tickSize: decision.orderBook.tick_size,
    negRisk: decision.orderBook.neg_risk,
  });
  if (result.success) {
    await syncTrackedSell(state, token, balance, result.orderID, targetSellPrice);
  }
}

async function checkSellOrderStatuses(client, state) {
  const sellTokens = getTokensByState(state, States.SELL_OPEN_002, States.SELL_OPEN_001);
  if (sellTokens.length === 0) return;

  for (const token of sellTokens) {
    const lock = acquireTokenLock(token.tokenID);
    await lock.wait;
    try {
      const balance = await getFilledShares(client, token.tokenID);
      const trackedToken = getToken(state, token.tokenID);
      if (trackedToken) trackedToken.filledShares = balance;

      const { sellOrders } = await getOpenOrdersForToken(client, token.tokenID);

      if (sellOrders.length === 0 && balance <= 0) {
        console.log(`[SELL] Fully sold ${token.question}`);
        await transitionToken(state, token.tokenID, States.SOLD, {
          filledShares: 0,
          sellOrderId: null,
          sellPrice: null,
        });
      } else if (sellOrders.length === 0 && balance > 0) {
        console.log(`[SELL] Sell order gone but balance remains for ${token.question}, balance=${balance}`);
        await transitionToken(state, token.tokenID, States.FILLED_WAIT_SELL, {
          sellOrderId: null,
          filledShares: balance,
        });
      }
    } catch (err) {
      console.error(`[SELL] Error checking sell status for ${token.tokenID.slice(0, 12)}...: ${err.message}`);
    } finally {
      lock.release();
    }
  }
}
