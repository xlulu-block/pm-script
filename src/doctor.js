import { AssetType } from "@polymarket/clob-client";
import { readFile } from "node:fs/promises";
import { ethers } from "ethers";
import { POLYMARKET_CONTRACTS } from "./approvals.js";
import { initClobClient } from "./clob.js";
import { config } from "./config.js";
import { getPolygonProvider } from "./rpc.js";

const ERC1155_ABI = [
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
];

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

function isPositiveBalance(balance) {
  try {
    return BigInt(String(balance ?? "0")) > 0n;
  } catch {
    return false;
  }
}

function takeUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function makeContextKey(context) {
  return `${context.signatureType}:${String(context.funderAddress || "").toLowerCase()}`;
}

function dedupeContexts(contexts) {
  const seen = new Set();
  const result = [];

  for (const context of contexts) {
    const key = makeContextKey(context);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(context);
  }

  return result;
}

function buildContexts() {
  return dedupeContexts([
    {
      label: "EOA 签名上下文",
      signatureType: 0,
      funderAddress: null,
    },
    {
      label: `当前配置的 ${formatSignatureType(config.SIGNATURE_TYPE)} 上下文`,
      signatureType: config.SIGNATURE_TYPE,
      funderAddress: config.EFFECTIVE_FUNDER_ADDRESS || null,
    },
  ]);
}

function parseCliTokenIDs() {
  const tokenIDs = [];
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--token" && args[i + 1]) {
      tokenIDs.push(args[i + 1]);
      i++;
    }
  }

  return takeUnique(tokenIDs);
}

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function parseNumberFlag(flag, defaultValue) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) return defaultValue;
  const parsed = Number.parseInt(args[index + 1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

async function loadStateTokenIDs() {
  try {
    const raw = JSON.parse(await readFile(config.STATE_FILE, "utf8"));
    return takeUnique([
      ...Object.keys(raw?.orderedTokens || {}),
      ...Object.keys(raw?.boughtTokens || {}),
    ]);
  } catch {
    return [];
  }
}

async function resolveInspectionTokenIDs(buyTrades) {
  const maxTokens = parseNumberFlag("--limit", hasFlag("--from-state") ? 25 : 30);
  const cliTokenIDs = parseCliTokenIDs();
  if (cliTokenIDs.length > 0) {
    console.log(`[Doctor] 使用 --token 指定的 ${cliTokenIDs.length} 个 token ID`);
    return cliTokenIDs.slice(0, maxTokens);
  }

  const preferState = hasFlag("--from-state");
  const stateTokenIDs = await loadStateTokenIDs();
  if (preferState) {
    const selected = stateTokenIDs.slice(0, maxTokens);
    console.log(
      `[Doctor] 从 ${config.STATE_FILE} 中使用 ${selected.length}/${stateTokenIDs.length} 个 token ID（limit=${maxTokens}）`
    );
    return selected;
  }

  if (stateTokenIDs.length > 0) {
    const merged = takeUnique([
      ...stateTokenIDs,
      ...takeUnique(buyTrades.map((trade) => trade.asset_id)),
    ]).slice(0, maxTokens);
    console.log(
      `[Doctor] 使用从 ${config.STATE_FILE} 与近期 BUY 交易合并得到的 ${merged.length} 个 token ID（limit=${maxTokens}）`
    );
    return merged;
  }

  const recentTradeTokenIDs = takeUnique(buyTrades.map((trade) => trade.asset_id)).slice(0, maxTokens);
  console.log(`[Doctor] 使用近期 BUY 交易中的 ${recentTradeTokenIDs.length} 个 token ID（limit=${maxTokens}）`);
  return recentTradeTokenIDs;
}

async function inspectConditionalBalances(client, tokenIDs) {
  const results = [];

  for (let i = 0; i < tokenIDs.length; i++) {
    const tokenID = tokenIDs[i];
    if (i === 0 || (i + 1) % 10 === 0 || i === tokenIDs.length - 1) {
      console.log(`[Doctor] 条件仓位余额检查进度: ${i + 1}/${tokenIDs.length}`);
    }
    const balance = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenID,
    });
    results.push({ tokenID, ...balance });
  }

  return results;
}

async function inspectOnchainConditionalBalances(account, tokenIDs) {
  const { provider, rpcUrl } = await getPolygonProvider(config.POLYGON_RPC_URL);
  const ctf = new ethers.Contract(POLYMARKET_CONTRACTS.CTF, ERC1155_ABI, provider);
  const balances = [];

  for (let i = 0; i < tokenIDs.length; i++) {
    const tokenID = tokenIDs[i];
    if (i === 0 || (i + 1) % 10 === 0 || i === tokenIDs.length - 1) {
      console.log(`[Doctor] 链上余额检查进度: ${i + 1}/${tokenIDs.length}`);
    }
    const balance = await ctf.balanceOf(account, tokenID);
    balances.push({
      tokenID,
      balance: balance.toString(),
    });
  }

  return {
    rpcUrl,
    balances,
  };
}

function scoreContext(summary) {
  let score = 0;

  if (isPositiveBalance(summary.collateralBalance)) score += 2;
  if (summary.nonZeroConditionalCount > 0) score += 4;
  if (summary.nonZeroOnchainCount > 0) score += 4;

  return score;
}

async function inspectContext(context, signerAddress) {
  const effectiveAccount = context.funderAddress || signerAddress;

  console.log(`=== 上下文: ${context.label} ===`);
  console.log(`签名地址: ${signerAddress}`);
  console.log(
    `签名类型: ${formatSignatureType(context.signatureType)} (${context.signatureType})`
  );
  console.log(`生效的 funder/maker: ${effectiveAccount}`);

  const client = await initClobClient({
    ensureCollateral: false,
    refreshCollateralCache: false,
    signatureType: context.signatureType,
    funderAddress: context.funderAddress || undefined,
  });

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log(
    `[Doctor] CLOB collateral 缓存 balance=${collateral.balance ?? "n/a"}, allowance=${collateral.allowance ?? "n/a"}`
  );

  const [openOrders, trades] = await Promise.all([
    client.getOpenOrders(undefined, true),
    client.getTrades(undefined, true),
  ]);

  console.log(`[Doctor] 已获取挂单数量: ${openOrders.length}`);
  console.log(`[Doctor] 已获取交易数量（第一页）: ${trades.length}`);

  const buyTrades = trades.filter((trade) => trade.side === "BUY");
  const sampleTokenIDs = await resolveInspectionTokenIDs(buyTrades);

  console.log(`[Doctor] 第一页 BUY 交易数量: ${buyTrades.length}`);

  let conditionalBalances = [];
  let onchain = { rpcUrl: null, balances: [] };

  if (sampleTokenIDs.length === 0) {
    console.log("[Doctor] 第一页未发现 BUY 交易，跳过条件仓位余额检查。");
  } else {
    console.log("[Doctor] 正在检查所选 token 的条件仓位余额...");
    conditionalBalances = await inspectConditionalBalances(client, sampleTokenIDs);
    for (const entry of conditionalBalances) {
      console.log(
        `  - token=${entry.tokenID} 条件余额=${entry.balance} 条件授权=${entry.allowance}`
      );
    }

    console.log("[Doctor] 正在检查同一批 token 的链上 ERC1155 余额...");
    onchain = await inspectOnchainConditionalBalances(effectiveAccount, sampleTokenIDs);
    console.log(`[Doctor] Polygon RPC: ${onchain.rpcUrl}`);
    for (const entry of onchain.balances) {
      console.log(`  - token=${entry.tokenID} 链上余额=${entry.balance}`);
    }
  }

  console.log();

  return {
    ...context,
    effectiveAccount,
    collateralBalance: collateral.balance ?? "0",
    openOrdersCount: openOrders.length,
    tradesCount: trades.length,
    buyTradesCount: buyTrades.length,
    nonZeroConditionalCount: conditionalBalances.filter((entry) => isPositiveBalance(entry.balance)).length,
    nonZeroOnchainCount: onchain.balances.filter((entry) => isPositiveBalance(entry.balance)).length,
  };
}

function printSummary(summaries) {
  console.log("=== 上下文汇总 ===");
  for (const summary of summaries) {
    if (summary.error) {
      console.log(
        `- ${summary.label}: 错误=${summary.error}`
      );
      continue;
    }

    console.log(
      `- ${summary.label}: collateral=${summary.collateralBalance}, 买入交易数=${summary.buyTradesCount}, 条件余额非零数=${summary.nonZeroConditionalCount}, 链上余额非零数=${summary.nonZeroOnchainCount}`
    );
  }
  console.log();
}

function printRecommendation(summaries) {
  const okSummaries = summaries.filter((summary) => !summary.error);
  if (okSummaries.length === 0) {
    console.log("[Doctor] 没有任何上下文检查成功完成。");
    return;
  }

  const ranked = [...okSummaries].sort((a, b) => scoreContext(b) - scoreContext(a));
  const best = ranked[0];
  const second = ranked[1];

  if (scoreContext(best) === 0) {
    console.log(
      "[Doctor] 无论是 EOA 上下文还是当前配置的 Polymarket 上下文，都没有表现出可用的 collateral 或抽样持仓。"
    );
    console.log(
      "[Doctor] 这通常说明你配置的 Polymarket 账户地址仍然不对，或者这些交易本来就属于另一个账户。"
    );
    return;
  }

  if (!second || scoreContext(best) > scoreContext(second)) {
    console.log(
      `[Doctor] 最匹配的上下文是: ${best.label} -> ${best.effectiveAccount}`
    );
    console.log(
      `[Doctor] 建议保留 SIGNATURE_TYPE=${best.signatureType}${best.funderAddress ? `，并设置 FUNDER_ADDRESS=${best.funderAddress}` : ""}。`
    );
    return;
  }

  console.log(
    "[Doctor] 存在多个看起来都合理的上下文。请选择与 Polymarket Portfolio 页面地址一致、且 conditional/on-chain 余额非零的那个。"
  );
}

async function main() {
  const wallet = new ethers.Wallet(config.PRIVATE_KEY);
  const signerAddress = wallet.address;
  const contexts = buildContexts();

  console.log("=== Polymarket 账户诊断 ===");
  console.log(`私钥对应签名地址: ${signerAddress}`);
  console.log();

  const summaries = [];

  for (const context of contexts) {
    try {
      const summary = await inspectContext(context, signerAddress);
      summaries.push(summary);
    } catch (err) {
      console.log(`=== 上下文: ${context.label} ===`);
      console.error(`[Doctor] 上下文检查失败: ${err.message || err}`);
      console.log();
      summaries.push({
        ...context,
        error: err.message || String(err),
      });
    }
  }

  printSummary(summaries);
  printRecommendation(summaries);
}

main().catch((err) => {
  console.error("[DOCTOR:FATAL] 程序异常退出:", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[DOCTOR:CAUSE] 原因: ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
