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
      label: "EOA signer context",
      signatureType: 0,
      funderAddress: null,
    },
    {
      label: `Configured ${formatSignatureType(config.SIGNATURE_TYPE)} context`,
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
    console.log(`[Doctor] Using ${cliTokenIDs.length} token ID(s) from --token`);
    return cliTokenIDs.slice(0, maxTokens);
  }

  const preferState = hasFlag("--from-state");
  const stateTokenIDs = await loadStateTokenIDs();
  if (preferState) {
    const selected = stateTokenIDs.slice(0, maxTokens);
    console.log(
      `[Doctor] Using ${selected.length}/${stateTokenIDs.length} token ID(s) from ${config.STATE_FILE} (limit=${maxTokens})`
    );
    return selected;
  }

  if (stateTokenIDs.length > 0) {
    const merged = takeUnique([
      ...stateTokenIDs,
      ...takeUnique(buyTrades.map((trade) => trade.asset_id)),
    ]).slice(0, maxTokens);
    console.log(
      `[Doctor] Using ${merged.length} token ID(s) merged from ${config.STATE_FILE} and recent BUY trades (limit=${maxTokens})`
    );
    return merged;
  }

  const recentTradeTokenIDs = takeUnique(buyTrades.map((trade) => trade.asset_id)).slice(0, maxTokens);
  console.log(`[Doctor] Using ${recentTradeTokenIDs.length} recent BUY trade token ID(s) (limit=${maxTokens})`);
  return recentTradeTokenIDs;
}

async function inspectConditionalBalances(client, tokenIDs) {
  const results = [];

  for (let i = 0; i < tokenIDs.length; i++) {
    const tokenID = tokenIDs[i];
    if (i === 0 || (i + 1) % 10 === 0 || i === tokenIDs.length - 1) {
      console.log(`[Doctor] Conditional balance progress: ${i + 1}/${tokenIDs.length}`);
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
      console.log(`[Doctor] On-chain balance progress: ${i + 1}/${tokenIDs.length}`);
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

  console.log(`=== Context: ${context.label} ===`);
  console.log(`Signer: ${signerAddress}`);
  console.log(
    `Signature type: ${formatSignatureType(context.signatureType)} (${context.signatureType})`
  );
  console.log(`Effective funder/maker: ${effectiveAccount}`);

  const client = await initClobClient({
    ensureCollateral: false,
    refreshCollateralCache: false,
    signatureType: context.signatureType,
    funderAddress: context.funderAddress || undefined,
  });

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  console.log(
    `[Doctor] CLOB collateral cache balance=${collateral.balance ?? "n/a"}, allowance=${collateral.allowance ?? "n/a"}`
  );

  const [openOrders, trades] = await Promise.all([
    client.getOpenOrders(undefined, true),
    client.getTrades(undefined, true),
  ]);

  console.log(`[Doctor] Open orders fetched: ${openOrders.length}`);
  console.log(`[Doctor] Trades fetched (first page): ${trades.length}`);

  const buyTrades = trades.filter((trade) => trade.side === "BUY");
  const sampleTokenIDs = await resolveInspectionTokenIDs(buyTrades);

  console.log(`[Doctor] BUY trades on first page: ${buyTrades.length}`);

  let conditionalBalances = [];
  let onchain = { rpcUrl: null, balances: [] };

  if (sampleTokenIDs.length === 0) {
    console.log("[Doctor] No BUY trades found on the first page, skipping conditional balance checks.");
  } else {
    console.log("[Doctor] Checking conditional balances for selected tokens...");
    conditionalBalances = await inspectConditionalBalances(client, sampleTokenIDs);
    for (const entry of conditionalBalances) {
      console.log(
        `  - token=${entry.tokenID} conditional_balance=${entry.balance} conditional_allowance=${entry.allowance}`
      );
    }

    console.log("[Doctor] Checking on-chain ERC1155 balances for the same tokens...");
    onchain = await inspectOnchainConditionalBalances(effectiveAccount, sampleTokenIDs);
    console.log(`[Doctor] Polygon RPC: ${onchain.rpcUrl}`);
    for (const entry of onchain.balances) {
      console.log(`  - token=${entry.tokenID} onchain_balance=${entry.balance}`);
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
  console.log("=== Context Summary ===");
  for (const summary of summaries) {
    if (summary.error) {
      console.log(
        `- ${summary.label}: error=${summary.error}`
      );
      continue;
    }

    console.log(
      `- ${summary.label}: collateral=${summary.collateralBalance}, buy_trades=${summary.buyTradesCount}, nonzero_conditional=${summary.nonZeroConditionalCount}, nonzero_onchain=${summary.nonZeroOnchainCount}`
    );
  }
  console.log();
}

function printRecommendation(summaries) {
  const okSummaries = summaries.filter((summary) => !summary.error);
  if (okSummaries.length === 0) {
    console.log("[Doctor] No successful context checks completed.");
    return;
  }

  const ranked = [...okSummaries].sort((a, b) => scoreContext(b) - scoreContext(a));
  const best = ranked[0];
  const second = ranked[1];

  if (scoreContext(best) === 0) {
    console.log(
      "[Doctor] Neither the EOA context nor the configured Polymarket context shows usable collateral or sampled positions."
    );
    console.log(
      "[Doctor] That strongly suggests you still have the wrong Polymarket account address, or the trades belong to another account entirely."
    );
    return;
  }

  if (!second || scoreContext(best) > scoreContext(second)) {
    console.log(
      `[Doctor] The strongest match is: ${best.label} -> ${best.effectiveAccount}`
    );
    console.log(
      `[Doctor] Keep SIGNATURE_TYPE=${best.signatureType}${best.funderAddress ? ` and FUNDER_ADDRESS=${best.funderAddress}` : ""}.`
    );
    return;
  }

  console.log(
    "[Doctor] Multiple contexts look plausible. Use the one that matches the address shown in Polymarket Portfolio and has non-zero conditional/on-chain balances."
  );
}

async function main() {
  const wallet = new ethers.Wallet(config.PRIVATE_KEY);
  const signerAddress = wallet.address;
  const contexts = buildContexts();

  console.log("=== Polymarket Account Doctor ===");
  console.log(`Signer private key address: ${signerAddress}`);
  console.log();

  const summaries = [];

  for (const context of contexts) {
    try {
      const summary = await inspectContext(context, signerAddress);
      summaries.push(summary);
    } catch (err) {
      console.log(`=== Context: ${context.label} ===`);
      console.error(`[Doctor] Context check failed: ${err.message || err}`);
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
  console.error("[DOCTOR:FATAL]", err.message || err);
  if (err?.cause?.message) {
    const causeCode = err.cause.code ? ` (${err.cause.code})` : "";
    console.error(`[DOCTOR:CAUSE] ${err.cause.message}${causeCode}`);
  }
  process.exit(1);
});
