import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { ensureEoaCollateralApprovals, getRequiredCollateralBaseUnits } from "./approvals.js";
import { config } from "./config.js";
import { analyzeBidDepth, getBuyPriceLevel, getDepthThreshold, shouldBuy } from "./depth.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_ORDER_SIDE = "BUY";

function countActiveBookLevels(levels) {
  if (!Array.isArray(levels)) return 0;
  return levels.filter((level) => Number(level?.size || 0) > 0).length;
}

function chunkArray(items, size) {
  const batchSize = Math.max(1, size);
  const chunks = [];
  for (let i = 0; i < items.length; i += batchSize) {
    chunks.push(items.slice(i, i + batchSize));
  }
  return chunks;
}

function getErrorMessage(err) {
  return err?.message || String(err);
}

function isRateLimitMessage(message) {
  const lowerMessage = String(message || "").toLowerCase();
  return lowerMessage.includes("429") || lowerMessage.includes("rate limit");
}

function getRetryDelayMs(attempt) {
  const baseDelay = Math.max(1, config.ORDER_BATCH_RETRY_BASE_MS);
  const exponential = baseDelay * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * baseDelay);
  return exponential + jitter;
}

function createSkipResult(question, reason, skipCategory) {
  console.log(`[ORDER] SKIPPED "${question}": ${reason}`);
  return { success: false, skipped: true, reason, skipCategory };
}

function evaluateBuyOrderBook(orderBook) {
  const expectedTickSize = getBuyPriceLevel(config);
  if (!orderBook) {
    if (!config.STRICT_ORDERBOOK_CHECK) {
      return { ok: true, orderOptions: undefined };
    }
    return { ok: false, reason: "order book missing from batch response", skipCategory: "book-check-failed" };
  }

  const bidLevels = countActiveBookLevels(orderBook?.bids);
  const askLevels = countActiveBookLevels(orderBook?.asks);
  if (askLevels > 0 && bidLevels === 0) {
    return {
      ok: false,
      reason: `ask-only order book (asks=${askLevels}, bids=${bidLevels})`,
      skipCategory: "ask-only",
    };
  }

  if (orderBook.tick_size && String(orderBook.tick_size) !== expectedTickSize) {
    return {
      ok: false,
      reason: `tick size mismatch (${orderBook.tick_size} != ${expectedTickSize})`,
      skipCategory: "tick-size-mismatch",
    };
  }

  const depth = analyzeBidDepth(orderBook, config);
  if (!shouldBuy(depth, config)) {
    return {
      ok: false,
      reason: `depth insufficient (bidAt${depth.buyPriceLevel}=${depth.bidSharesAtBuyPrice}, threshold=${getDepthThreshold(config)})`,
      skipCategory: "depth-insufficient",
    };
  }

  return {
    ok: true,
    orderOptions: {
      tickSize: orderBook.tick_size,
      negRisk: orderBook.neg_risk,
    },
  };
}

async function debounceQualifiedBuyItems(client, signableItems, resultsByIndex) {
  if (signableItems.length === 0 || config.BUY_DEPTH_DEBOUNCE_MS <= 0) {
    return signableItems;
  }

  console.log(
    `[ORDER] Debouncing ${signableItems.length} buy candidate(s) for ${config.BUY_DEPTH_DEBOUNCE_MS}ms`
  );
  await sleep(config.BUY_DEPTH_DEBOUNCE_MS);

  let bookByTokenID;
  try {
    bookByTokenID = await inspectBatchOrderBooks(client, signableItems);
  } catch (err) {
    const reason = `buy debounce order book check failed: ${getErrorMessage(err)}`;
    for (const { target, index } of signableItems) {
      resultsByIndex.set(index, createSkipResult(target.question, reason, "depth-debounce-failed"));
    }
    return [];
  }

  const confirmedItems = [];
  for (const workItem of signableItems) {
    const { target, index } = workItem;
    const evaluation = evaluateBuyOrderBook(bookByTokenID.get(target.tokenID));
    if (!evaluation.ok) {
      resultsByIndex.set(
        index,
        createSkipResult(target.question, `buy debounce rejected: ${evaluation.reason}`, "depth-debounce-failed")
      );
      continue;
    }

    confirmedItems.push({
      ...workItem,
      orderOptions: evaluation.orderOptions,
    });
  }

  return confirmedItems;
}

function classifyFailure(question, err) {
  const msg = getErrorMessage(err);
  const lowerMsg = msg.toLowerCase();

  if (lowerMsg.includes("allowance")) {
    console.error(`[ORDER] ALLOWANCE ISSUE - stopping all orders`);
    const guidance =
      config.SIGNATURE_TYPE === 2
        ? " SIGNATURE_TYPE=2 is only valid for actual Polymarket Gnosis Safe accounts. For a normal wallet private key plus a Polymarket profile/funder address, use SIGNATURE_TYPE=1."
        : "";
    return { success: false, error: `${msg}${guidance}`, stopAll: true };
  }

  if (lowerMsg.includes("insufficient") || lowerMsg.includes("not enough balance")) {
    console.error(`[ORDER] INSUFFICIENT BALANCE - stopping all orders`);
    return { success: false, error: msg, stopAll: true };
  }

  if (isRateLimitMessage(msg)) {
    console.warn(`[ORDER] RATE LIMITED "${question}": ${msg}`);
    return { success: false, error: msg, retryable: true };
  }

  console.error(`[ORDER] FAILED "${question}": ${msg}`);
  return { success: false, error: msg };
}

function normalizePostOrdersResponse(response, expectedCount) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  if (expectedCount === 1 && response) {
    return [response];
  }
  return null;
}

export async function inspectBatchOrderBooks(client, workItems) {
  const params = workItems.map(({ target }) => ({
    token_id: target.tokenID,
    side: Side.BUY,
  }));

  const orderBooks = await client.getOrderBooks(params);
  const bookByTokenID = new Map();
  if (Array.isArray(orderBooks)) {
    for (const book of orderBooks) {
      if (book?.asset_id) {
        bookByTokenID.set(book.asset_id, book);
      }
    }
  }
  return bookByTokenID;
}

async function processOrderBatch(client, workItems, attempt = 1) {
  if (workItems.length === 0) {
    return new Map();
  }

  const resultsByIndex = new Map();
  const retryableItems = [];
  let bookByTokenID = new Map();

  try {
    bookByTokenID = await inspectBatchOrderBooks(client, workItems);
  } catch (err) {
    const reason = `order book inspection failed: ${getErrorMessage(err)}`;
    if (config.STRICT_ORDERBOOK_CHECK) {
      for (const { target, index } of workItems) {
        resultsByIndex.set(index, createSkipResult(target.question, reason, "book-check-failed"));
      }
      return resultsByIndex;
    }
    console.warn(`[ORDER] Batch order book inspection failed (continuing): ${reason}`);
  }

  let signableItems = [];

  for (const workItem of workItems) {
    const { target, index } = workItem;
    const orderBook = bookByTokenID.get(target.tokenID);

    const evaluation = evaluateBuyOrderBook(orderBook);
    if (!evaluation.ok) {
      resultsByIndex.set(index, createSkipResult(target.question, evaluation.reason, evaluation.skipCategory));
      continue;
    }

    signableItems.push({
      ...workItem,
      orderOptions: evaluation.orderOptions,
    });
  }

  signableItems = await debounceQualifiedBuyItems(client, signableItems, resultsByIndex);

  const signedItems = [];
  const createResults = await Promise.all(
    signableItems.map(async (workItem) => {
      const { target } = workItem;
      const orderParams = {
        tokenID: target.tokenID,
        price: config.ORDER_PRICE,
        side: DEFAULT_ORDER_SIDE,
        size: config.ORDER_SIZE,
      };

      try {
        const order = await client.createOrder(orderParams, workItem.orderOptions);
        return { ok: true, workItem, order };
      } catch (err) {
        return { ok: false, workItem, err };
      }
    })
  );

  for (const createResult of createResults) {
    const { workItem } = createResult;
    const { target, index } = workItem;

    if (createResult.ok) {
      signedItems.push(createResult);
      continue;
    }

    const failure = classifyFailure(target.question, createResult.err);
    if (failure.retryable) {
      retryableItems.push(workItem);
    } else {
      resultsByIndex.set(index, failure);
    }
  }

  if (signedItems.length > 0) {
    try {
      const payload = signedItems.map(({ order }) => ({
        order,
        orderType: OrderType.GTC,
      }));
      const response = await client.postOrders(payload, false, config.POST_ONLY);
      const normalized = normalizePostOrdersResponse(response, signedItems.length);

      if (!normalized || normalized.length !== signedItems.length) {
        throw new Error("unexpected batch order response shape");
      }

      for (let i = 0; i < signedItems.length; i++) {
        const { workItem } = signedItems[i];
        const { target, index } = workItem;
        const itemResponse = normalized[i];

        if (itemResponse?.error || itemResponse?.success === false || itemResponse?.errorMsg) {
          const failure = classifyFailure(
            target.question,
            itemResponse?.error || itemResponse?.errorMsg || "batch post failed"
          );
          if (failure.retryable) {
            retryableItems.push(workItem);
          } else {
            resultsByIndex.set(index, failure);
          }
          continue;
        }

        console.log(
          `[ORDER] SUCCESS "${target.question}" tokenID=${target.tokenID.slice(0, 12)}... orderID=${itemResponse?.orderID || "n/a"}`
        );
        resultsByIndex.set(index, { success: true, result: itemResponse });
      }
    } catch (err) {
      if (isRateLimitMessage(getErrorMessage(err))) {
        for (const { workItem } of signedItems) {
          retryableItems.push(workItem);
        }
      } else {
        for (const { workItem } of signedItems) {
          const { target, index } = workItem;
          resultsByIndex.set(index, classifyFailure(target.question, err));
        }
      }
    }
  }

  if (retryableItems.length > 0) {
    if (attempt > config.ORDER_BATCH_MAX_RETRIES) {
      for (const workItem of retryableItems) {
        resultsByIndex.set(workItem.index, {
          success: false,
          error: `rate limited after ${config.ORDER_BATCH_MAX_RETRIES} retries`,
        });
      }
      return resultsByIndex;
    }

    const nextBatchSize = retryableItems.length > config.ORDER_BATCH_MIN_SIZE
      ? Math.max(config.ORDER_BATCH_MIN_SIZE, Math.floor(retryableItems.length / 2))
      : retryableItems.length;
    const delayMs = getRetryDelayMs(attempt);
    console.warn(
      `[ORDER] Retrying ${retryableItems.length} rate-limited order(s) in ${delayMs}ms (attempt ${attempt}/${config.ORDER_BATCH_MAX_RETRIES}, next batch size ${nextBatchSize})`
    );
    await sleep(delayMs);

    const retryChunks = chunkArray(retryableItems, nextBatchSize);
    for (const retryChunk of retryChunks) {
      const retryResults = await processOrderBatch(client, retryChunk, attempt + 1);
      for (const [index, result] of retryResults.entries()) {
        resultsByIndex.set(index, result);
      }
    }
  }

  return resultsByIndex;
}

function formatSignatureType(signatureType) {
  switch (signatureType) {
    case 0:
      return "EOA";
    case 1:
      return "POLY_PROXY";
    case 2:
      return "POLY_GNOSIS_SAFE";
    default:
      return `UNKNOWN(${signatureType})`;
  }
}

function parseOptionalBigInt(value) {
  if (value === null || value === undefined || value === "n/a") return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function getNonEoaAllowanceHint(signatureType) {
  if (signatureType === 2) {
    return "SIGNATURE_TYPE=2 only works for actual Polymarket Gnosis Safe accounts. If you are using a normal wallet private key plus a Polymarket profile/funder address, switch to SIGNATURE_TYPE=1 instead.";
  }

  if (signatureType === 1) {
    return "The Polymarket profile/funder address has balance but zero allowance. This usually means the profile wallet was funded, but its Polymarket collateral approvals were never initialized.";
  }

  return "The configured account has zero collateral allowance.";
}

function logAllowanceSnapshot(prefix, entries) {
  for (const entry of entries) {
    console.log(
      `${prefix} ${entry.key} allowance=${ethers.utils.formatUnits(entry.allowance, 6)} USDC.e`
    );
  }
}

async function ensureCollateralReady(wallet, signatureType) {
  if (signatureType !== 0) {
    console.log("[CLOB] Skipping EOA collateral approval check for non-EOA signature type");
    return;
  }

  const minimumAllowance = getRequiredCollateralBaseUnits(
    config.ORDER_PRICE,
    config.ORDER_SIZE
  );

  console.log(
    `[CLOB] Resolving Polygon RPC and checking on-chain USDC.e approvals (required per order: ${ethers.utils.formatUnits(minimumAllowance, 6)} USDC.e)...`
  );

  const status = await ensureEoaCollateralApprovals(
    wallet,
    config.POLYGON_RPC_URL,
    minimumAllowance,
    config.AUTO_APPROVE_COLLATERAL
  );

  console.log(`[CLOB] Using Polygon RPC: ${status.rpcUrl}`);
  console.log(`[CLOB] On-chain USDC.e balance=${status.balanceFormatted}`);
  logAllowanceSnapshot("[CLOB]", status.allowancesAfter);

  if (status.approvals.length > 0) {
    for (const approval of status.approvals) {
      console.log(
        `[CLOB] Approved ${approval.spender} (${approval.address}) tx=${approval.hash}`
      );
    }
  }

  if (status.missingAfter.length > 0) {
    const missing = status.missingAfter.map((entry) => entry.key).join(", ");
    const hint = config.AUTO_APPROVE_COLLATERAL
      ? "Automatic approve did not complete successfully."
      : "Set AUTO_APPROVE_COLLATERAL=true or approve these spenders manually.";
    throw new Error(`Missing USDC.e allowance for ${missing}. ${hint}`);
  }
}

export async function initClobClient(options = {}) {
  const ensureCollateral = options.ensureCollateral ?? true;
  const refreshCollateralCache = options.refreshCollateralCache ?? true;
  const signatureType = options.signatureType ?? config.SIGNATURE_TYPE;
  const funderAddress = Object.prototype.hasOwnProperty.call(options, "funderAddress")
    ? options.funderAddress
    : (config.EFFECTIVE_FUNDER_ADDRESS || undefined);
  const wallet = new ethers.Wallet(config.PRIVATE_KEY);
  const effectiveMaker = funderAddress || wallet.address;
  console.log(`[CLOB] Wallet address: ${wallet.address}`);
  console.log(
    `[CLOB] Signature type: ${formatSignatureType(signatureType)} (${signatureType})`
  );
  console.log(
    `[CLOB] Effective maker/funder: ${effectiveMaker}`
  );

  // Step 1: unauthenticated client to derive API creds
  const tempClient = new ClobClient(
    config.CLOB_HOST,
    config.CHAIN_ID,
    wallet,
    undefined,
    signatureType,
    funderAddress,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );

  // Step 2: derive API credentials
  console.log("[CLOB] Deriving API credentials...");
  const creds = await tempClient.createOrDeriveApiKey();

  // Step 3: authenticated client
  const client = new ClobClient(
    config.CLOB_HOST,
    config.CHAIN_ID,
    wallet,
    creds,
    signatureType,
    funderAddress,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );

  // Step 4: ensure on-chain approvals for EOA wallets
  if (ensureCollateral) {
    await ensureCollateralReady(wallet, signatureType);
  } else {
    console.log("[CLOB] Skipping collateral approval check by request");
  }

  // Step 5: refresh CLOB-side balance/allowance cache for diagnostics
  if (refreshCollateralCache) {
    console.log("[CLOB] Refreshing CLOB balance/allowance cache...");
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log(
      `[CLOB] CLOB collateral cache balance=${collateral.balance ?? "n/a"}, allowance=${collateral.allowance ?? "n/a"}`
    );

    const collateralBalance = parseOptionalBigInt(collateral.balance);
    const collateralAllowance = parseOptionalBigInt(collateral.allowance);
    if (
      signatureType !== 0 &&
      collateralBalance !== null &&
      collateralBalance > 0n &&
      collateralAllowance !== null &&
      collateralAllowance === 0n
    ) {
      throw new Error(
        `CLOB collateral allowance is zero for funder ${effectiveMaker} under ${formatSignatureType(signatureType)}. ${getNonEoaAllowanceHint(signatureType)}`
      );
    }
  }

  console.log("[CLOB] Client initialized successfully");
  return client;
}

export async function getExistingOrderTokenIDs(client) {
  try {
    const openOrders = await client.getOpenOrders();
    const tokenIDs = new Set();
    if (Array.isArray(openOrders)) {
      for (const order of openOrders) {
        if (order.asset_id) tokenIDs.add(order.asset_id);
        if (order.tokenID) tokenIDs.add(order.tokenID);
      }
    }
    console.log(`[CLOB] Found ${tokenIDs.size} existing open order token IDs`);
    return tokenIDs;
  } catch (err) {
    console.warn(`[CLOB] Failed to fetch open orders (continuing without dedup): ${err.message}`);
    return new Set();
  }
}

export async function getBoughtTokenIDs(client) {
  try {
    const trades = await client.getTrades();
    const tokenIDs = new Set();

    if (Array.isArray(trades)) {
      for (const trade of trades) {
        if (trade.side === "BUY" && trade.asset_id) {
          tokenIDs.add(trade.asset_id);
        }
      }
    }

    console.log(`[CLOB] Found ${tokenIDs.size} bought token IDs from trade history`);
    return tokenIDs;
  } catch (err) {
    console.warn(`[CLOB] Failed to fetch trade history (continuing without bought dedup): ${err.message}`);
    return new Set();
  }
}

export async function placeOrdersBatch(client, targets) {
  const workItems = targets.map((target, index) => ({ target, index }));
  const resultsByIndex = await processOrderBatch(client, workItems);
  return targets.map((_, index) => {
    return resultsByIndex.get(index) || { success: false, error: "unknown batch order result" };
  });
}

export async function placeOrder(client, tokenID, question) {
  const [result] = await placeOrdersBatch(client, [{ tokenID, question }]);
  return result;
}
