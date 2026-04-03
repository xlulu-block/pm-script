import { AssetType, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { ensureEoaCollateralApprovals, getRequiredCollateralBaseUnits } from "./approvals.js";
import { config } from "./config.js";
import { analyzeBidDepth, getBuyPriceLevel, getDepthThreshold, shouldBuy } from "./depth.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_ORDER_SIDE = "BUY";
const BOUGHT_TOKEN_IDS_CACHE_TTL_MS = Math.max(60_000, Number(config.SELL_SCAN_INTERVAL_MS || 0));

let boughtTokenIDsCache = null;
let boughtTokenIDsCacheExpiresAt = 0;

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
  console.log(`[ORDER] 已跳过 "${question}": ${reason}`);
  return { success: false, skipped: true, reason, skipCategory };
}

function evaluateBuyOrderBook(orderBook) {
  const expectedTickSize = getBuyPriceLevel(config);
  if (!orderBook) {
    if (!config.STRICT_ORDERBOOK_CHECK) {
      return { ok: true, orderOptions: undefined };
    }
    return { ok: false, reason: "批量返回结果中缺少盘口", skipCategory: "book-check-failed" };
  }

  const bidLevels = countActiveBookLevels(orderBook?.bids);
  const askLevels = countActiveBookLevels(orderBook?.asks);
  if (askLevels > 0 && bidLevels === 0) {
    return {
      ok: false,
      reason: `盘口只有卖盘没有买盘（asks=${askLevels}, bids=${bidLevels}）`,
      skipCategory: "ask-only",
    };
  }

  if (orderBook.tick_size && String(orderBook.tick_size) !== expectedTickSize) {
    return {
      ok: false,
      reason: `tick size 不匹配（${orderBook.tick_size} != ${expectedTickSize}）`,
      skipCategory: "tick-size-mismatch",
    };
  }

  const depth = analyzeBidDepth(orderBook, config);
  if (!shouldBuy(depth, config)) {
    return {
      ok: false,
      reason: `深度不足（bidAt${depth.buyPriceLevel}=${depth.bidSharesAtBuyPrice}, threshold=${getDepthThreshold(config)}）`,
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
    `[ORDER] 对 ${signableItems.length} 个买入候选执行 ${config.BUY_DEPTH_DEBOUNCE_MS}ms 防抖复核`
  );
  await sleep(config.BUY_DEPTH_DEBOUNCE_MS);

  let bookByTokenID;
  try {
    bookByTokenID = await inspectBatchOrderBooks(client, signableItems);
  } catch (err) {
    const reason = `买入防抖阶段盘口检查失败: ${getErrorMessage(err)}`;
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
        createSkipResult(target.question, `买入防抖复核未通过: ${evaluation.reason}`, "depth-debounce-failed")
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
    console.error("[ORDER] 检测到 allowance 问题，停止后续全部下单");
    const guidance =
      config.SIGNATURE_TYPE === 2
        ? " SIGNATURE_TYPE=2 只适用于真实的 Polymarket Gnosis Safe 账户。如果你用的是普通钱包私钥 + Polymarket profile/funder 地址，应改为 SIGNATURE_TYPE=1。"
        : "";
    return { success: false, error: `${msg}${guidance}`, stopAll: true };
  }

  if (lowerMsg.includes("insufficient") || lowerMsg.includes("not enough balance")) {
    console.error("[ORDER] 余额不足，停止后续全部下单");
    return { success: false, error: msg, stopAll: true };
  }

  if (isRateLimitMessage(msg)) {
    console.warn(`[ORDER] 请求限流 "${question}": ${msg}`);
    return { success: false, error: msg, retryable: true };
  }

  console.error(`[ORDER] 下单失败 "${question}": ${msg}`);
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

function classifyOpenOrdersByTokenID(openOrders) {
  const ordersByTokenID = new Map();
  const tokenIDs = new Set();

  if (!Array.isArray(openOrders)) {
    return { ordersByTokenID, tokenIDs };
  }

  for (const order of openOrders) {
    const tokenID = order?.asset_id || order?.tokenID || null;
    if (!tokenID) continue;

    tokenIDs.add(tokenID);
    const current = ordersByTokenID.get(tokenID) || { buyOrders: [], sellOrders: [] };
    const side = String(order?.side || "").toUpperCase();

    if (side === "BUY") current.buyOrders.push(order);
    if (side === "SELL") current.sellOrders.push(order);

    ordersByTokenID.set(tokenID, current);
  }

  return { ordersByTokenID, tokenIDs };
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
    const reason = `盘口检查失败: ${getErrorMessage(err)}`;
    if (config.STRICT_ORDERBOOK_CHECK) {
      for (const { target, index } of workItems) {
        resultsByIndex.set(index, createSkipResult(target.question, reason, "book-check-failed"));
      }
      return resultsByIndex;
    }
    console.warn(`[ORDER] 批量盘口检查失败，但继续执行: ${reason}`);
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
        throw new Error("批量下单返回结构异常");
      }

      for (let i = 0; i < signedItems.length; i++) {
        const { workItem } = signedItems[i];
        const { target, index } = workItem;
        const itemResponse = normalized[i];

        if (itemResponse?.error || itemResponse?.success === false || itemResponse?.errorMsg) {
          const failure = classifyFailure(
            target.question,
            itemResponse?.error || itemResponse?.errorMsg || "批量下单失败"
          );
          if (failure.retryable) {
            retryableItems.push(workItem);
          } else {
            resultsByIndex.set(index, failure);
          }
          continue;
        }

        console.log(
          `[ORDER] 下单成功 "${target.question}" tokenID=${target.tokenID.slice(0, 12)}... orderID=${itemResponse?.orderID || "n/a"}`
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
          error: `限流重试 ${config.ORDER_BATCH_MAX_RETRIES} 次后仍失败`,
        });
      }
      return resultsByIndex;
    }

    const nextBatchSize = retryableItems.length > config.ORDER_BATCH_MIN_SIZE
      ? Math.max(config.ORDER_BATCH_MIN_SIZE, Math.floor(retryableItems.length / 2))
      : retryableItems.length;
    const delayMs = getRetryDelayMs(attempt);
    console.warn(
      `[ORDER] ${retryableItems.length} 笔限流订单将在 ${delayMs}ms 后重试（第 ${attempt}/${config.ORDER_BATCH_MAX_RETRIES} 次，下一批大小 ${nextBatchSize}）`
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
    return "SIGNATURE_TYPE=2 只适用于真实的 Polymarket Gnosis Safe 账户。如果你使用的是普通钱包私钥加 Polymarket profile/funder 地址，请改成 SIGNATURE_TYPE=1。";
  }

  if (signatureType === 1) {
    return "Polymarket profile/funder 地址有余额但 allowance 为 0。这通常表示 profile 钱包虽然入金了，但还没有初始化 Polymarket collateral 授权。";
  }

  return "当前配置账户的 collateral allowance 为 0。";
}

function logAllowanceSnapshot(prefix, entries) {
  for (const entry of entries) {
    console.log(
      `${prefix} ${entry.key} 授权额度=${ethers.utils.formatUnits(entry.allowance, 6)} USDC.e`
    );
  }
}

async function ensureCollateralReady(wallet, signatureType) {
  if (signatureType !== 0) {
    console.log("[CLOB] 当前不是 EOA 签名类型，跳过 EOA collateral 授权检查");
    return;
  }

  const minimumAllowance = getRequiredCollateralBaseUnits(
    config.ORDER_PRICE,
    config.ORDER_SIZE
  );

  console.log(
    `[CLOB] 正在解析 Polygon RPC，并检查链上 USDC.e 授权（每笔订单至少需要 ${ethers.utils.formatUnits(minimumAllowance, 6)} USDC.e）...`
  );

  const status = await ensureEoaCollateralApprovals(
    wallet,
    config.POLYGON_RPC_URL,
    minimumAllowance,
    config.AUTO_APPROVE_COLLATERAL
  );

  console.log(`[CLOB] 当前使用 Polygon RPC: ${status.rpcUrl}`);
  console.log(`[CLOB] 链上 USDC.e 余额=${status.balanceFormatted}`);
  logAllowanceSnapshot("[CLOB]", status.allowancesAfter);

  if (status.approvals.length > 0) {
    for (const approval of status.approvals) {
      console.log(
        `[CLOB] 已完成 ${approval.spender} (${approval.address}) 授权，tx=${approval.hash}`
      );
    }
  }

  if (status.missingAfter.length > 0) {
    const missing = status.missingAfter.map((entry) => entry.key).join(", ");
    const hint = config.AUTO_APPROVE_COLLATERAL
      ? "自动授权未能成功完成。"
      : "请设置 AUTO_APPROVE_COLLATERAL=true，或手动授权这些 spender。";
    throw new Error(`USDC.e 对 ${missing} 的 allowance 缺失。${hint}`);
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
  console.log(`[CLOB] 钱包地址: ${wallet.address}`);
  console.log(
    `[CLOB] 签名类型: ${formatSignatureType(signatureType)} (${signatureType})`
  );
  console.log(
    `[CLOB] 生效的 maker/funder: ${effectiveMaker}`
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
  console.log("[CLOB] 正在生成 API 凭证...");
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
    console.log("[CLOB] 按要求跳过 collateral 授权检查");
  }

  // Step 5: refresh CLOB-side balance/allowance cache for diagnostics
  if (refreshCollateralCache) {
    console.log("[CLOB] 正在刷新 CLOB 余额/授权缓存...");
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    console.log(
      `[CLOB] CLOB collateral 缓存 balance=${collateral.balance ?? "n/a"}, allowance=${collateral.allowance ?? "n/a"}`
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
        `${formatSignatureType(signatureType)} 模式下，funder ${effectiveMaker} 的 CLOB collateral allowance 为 0。${getNonEoaAllowanceHint(signatureType)}`
      );
    }
  }

  console.log("[CLOB] 客户端初始化成功");
  return client;
}

export async function getAccountOpenOrders(client) {
  try {
    const openOrders = await client.getOpenOrders();
    const { ordersByTokenID, tokenIDs } = classifyOpenOrdersByTokenID(openOrders);
    console.log(`[CLOB] 找到 ${tokenIDs.size} 个已有挂单的 token ID`);
    return { openOrders, ordersByTokenID, tokenIDs };
  } catch (err) {
    console.warn(`[CLOB] 获取挂单失败（将继续执行，但不做去重）: ${err.message}`);
    return { openOrders: [], ordersByTokenID: new Map(), tokenIDs: new Set() };
  }
}

export function getOpenOrdersForTokenFromSnapshot(snapshot, tokenID) {
  return snapshot?.ordersByTokenID?.get(tokenID) || { buyOrders: [], sellOrders: [] };
}

export async function getExistingOrderTokenIDs(client) {
  const snapshot = await getAccountOpenOrders(client);
  return snapshot.tokenIDs;
}

export async function getBoughtTokenIDs(client, options = {}) {
  const forceRefresh = options.forceRefresh ?? false;
  if (!forceRefresh && boughtTokenIDsCache && boughtTokenIDsCacheExpiresAt > Date.now()) {
    console.log(`[CLOB] Using cached BUY trade token IDs (${boughtTokenIDsCache.length})`);
    return new Set(boughtTokenIDsCache);
  }

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

    console.log(`[CLOB] 从交易历史中找到 ${tokenIDs.size} 个买入过的 token ID`);
    boughtTokenIDsCache = [...tokenIDs];
    boughtTokenIDsCacheExpiresAt = Date.now() + BOUGHT_TOKEN_IDS_CACHE_TTL_MS;
    return tokenIDs;
  } catch (err) {
    console.warn(`[CLOB] 获取交易历史失败（将继续执行，但不做已买入去重）: ${err.message}`);
    return new Set();
  }
}

export async function placeOrdersBatch(client, targets) {
  const workItems = targets.map((target, index) => ({ target, index }));
  const resultsByIndex = await processOrderBatch(client, workItems);
  return targets.map((_, index) => {
    return resultsByIndex.get(index) || { success: false, error: "未知的批量下单结果" };
  });
}

export async function placeOrder(client, tokenID, question) {
  const [result] = await placeOrdersBatch(client, [{ tokenID, question }]);
  return result;
}
