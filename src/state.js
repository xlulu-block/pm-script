import { readFile, writeFile, rename, access } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { config } from "./config.js";
import { States, validateTransition } from "./state-machine.js";

const LEGACY_STATE_ALIASES = Object.freeze({
  "sell_open_0.01": States.SELL_OPEN_001,
  "sell_open_0.02": States.SELL_OPEN_002,
});

function createEmptyState() {
  return { tokens: {} };
}

function normalizeTrackedToken(tokenID, token = {}) {
  return {
    tokenID,
    question: "",
    category: "",
    slug: null,
    state: States.CANDIDATE,
    buyOrderId: null,
    sellOrderId: null,
    filledShares: 0,
    sellPrice: null,
    lastSeenBidSharesAtOrderPrice: null,
    lastActionAt: new Date().toISOString(),
    lastError: null,
    createdAt: new Date().toISOString(),
    ...token,
    state: LEGACY_STATE_ALIASES[token.state] || token.state || States.CANDIDATE,
    lastSeenBidSharesAtOrderPrice:
      token.lastSeenBidSharesAtOrderPrice ?? token.lastSeenBidSharesAt001 ?? null,
  };
}

function migrateFromLegacy(raw) {
  const state = createEmptyState();
  const ordered = raw.orderedTokens || {};
  const bought = raw.boughtTokens || {};
  const allIDs = new Set([...Object.keys(ordered), ...Object.keys(bought)]);

  for (const tokenID of allIDs) {
    const fromOrdered = ordered[tokenID];
    const fromBought = bought[tokenID];
    const isBought = Boolean(fromBought);

    state.tokens[tokenID] = normalizeTrackedToken(tokenID, {
      question: fromOrdered?.question || fromBought?.question || "",
      category: fromOrdered?.category || "",
      slug: fromOrdered?.slug || null,
      state: isBought ? States.FILLED_WAIT_SELL : States.BUY_OPEN,
      buyOrderId: null,
      sellOrderId: null,
      filledShares: 0,
      sellPrice: null,
      lastActionAt: fromOrdered?.firstOrderedAt || fromBought?.firstBoughtAt || null,
      lastError: null,
      createdAt: fromOrdered?.firstOrderedAt || fromBought?.firstBoughtAt || new Date().toISOString(),
    });
  }

  return state;
}

function isLegacyFormat(raw) {
  return raw && (typeof raw.orderedTokens === "object" || typeof raw.boughtTokens === "object") && !raw.tokens;
}

export async function loadState(path) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return createEmptyState();
    throw err;
  }

  if (isLegacyFormat(raw)) {
    console.log("[State] Detected legacy state format, migrating...");
    const backupPath = path.replace(/\.json$/, ".backup.json");
    try {
      await access(backupPath);
    } catch {
      await writeFile(backupPath, JSON.stringify(raw, null, 2), "utf8");
      console.log(`[State] Legacy state backed up to ${backupPath}`);
    }
    const migrated = migrateFromLegacy(raw);
    const tokenCount = Object.keys(migrated.tokens).length;
    console.log(`[State] Migrated ${tokenCount} tokens from legacy format`);
    return migrated;
  }

  const tokens = {};
  for (const [tokenID, token] of Object.entries(raw.tokens || {})) {
    tokens[tokenID] = normalizeTrackedToken(tokenID, token);
  }

  return { tokens };
}

export async function saveState(path, state) {
  const payload = { tokens: state.tokens, updatedAt: new Date().toISOString() };
  const tmpPath = path + ".tmp";
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmpPath, path);
}

export function getToken(state, tokenID) {
  return state.tokens[tokenID] || null;
}

export function upsertToken(state, tokenID, fields) {
  const existing = state.tokens[tokenID];
  if (existing) {
    Object.assign(existing, fields, { lastActionAt: new Date().toISOString() });
  } else {
    state.tokens[tokenID] = normalizeTrackedToken(tokenID, fields);
  }
  return state.tokens[tokenID];
}

export async function transitionToken(state, tokenID, newState, extraFields = {}) {
  const token = state.tokens[tokenID];
  if (!token) {
    throw new Error(`Token ${tokenID} not found in state`);
  }
  const from = token.state;
  validateTransition(from, newState);
  token.state = newState;
  token.lastActionAt = new Date().toISOString();
  Object.assign(token, extraFields);

  // Append to state change log
  const entry = {
    timestamp: new Date().toISOString(),
    tokenID,
    from,
    to: newState,
    question: token.question,
    details: extraFields,
  };
  await appendFile(config.STATE_CHANGE_LOG_FILE, JSON.stringify(entry) + "\n", "utf8").catch(() => {});
  return token;
}

export function getTokensByState(state, ...states) {
  const stateSet = new Set(states);
  return Object.values(state.tokens).filter((t) => stateSet.has(t.state));
}

export function getAllTokenIDs(state) {
  return new Set(Object.keys(state.tokens));
}
