import dotenv from "dotenv";
import https from "https";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

dotenv.config({ override: true });

const argv = new Set(process.argv.slice(2));
const cliDryRun = argv.has("--dry-run");
const envDryRun = (process.env.DRY_RUN || "false").toLowerCase() === "true";
const DRY_RUN = cliDryRun || envDryRun;

function envOrDefault(key, defaultVal) {
  const val = process.env[key];
  return val !== undefined ? val : defaultVal;
}

function parseBooleanEnv(key, defaultVal = false) {
  const raw = envOrDefault(key, defaultVal ? "true" : "false");
  return raw.toLowerCase() === "true";
}

function parseNumberEnv(key, defaultVal, parser = parseFloat) {
  const raw = envOrDefault(key, defaultVal);
  const value = parser(raw);
  if (!Number.isFinite(value)) {
    console.error(`[Config] ${key} must be a valid number`);
    process.exit(1);
  }
  return value;
}

const DISABLE_PROXY = parseBooleanEnv("DISABLE_PROXY", false);
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

// Auto-configure proxy for users behind GFW or corporate firewalls
if (DISABLE_PROXY) {
  console.log("[Config] Proxy disabled via DISABLE_PROXY=true");
} else if (proxyUrl) {
  console.log(`[Config] Using proxy: ${proxyUrl}`);
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  https.globalAgent = new HttpsProxyAgent(proxyUrl);
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!DRY_RUN && !PRIVATE_KEY) {
  console.error("[Config] PRIVATE_KEY is required in .env");
  process.exit(1);
}
if (PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)) {
  console.error("[Config] PRIVATE_KEY must be a 0x-prefixed 64-char hex string");
  process.exit(1);
}

const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || null;
if (FUNDER_ADDRESS && !/^0x[0-9a-fA-F]{40}$/.test(FUNDER_ADDRESS)) {
  console.error("[Config] FUNDER_ADDRESS must be a valid 0x-prefixed address");
  process.exit(1);
}

const SIGNATURE_TYPE = parseNumberEnv("SIGNATURE_TYPE", "0", (value) => parseInt(value, 10));
if (![0, 1, 2].includes(SIGNATURE_TYPE)) {
  console.error("[Config] SIGNATURE_TYPE must be 0 (EOA), 1 (POLY_PROXY), or 2 (GNOSIS_SAFE)");
  process.exit(1);
}

if (SIGNATURE_TYPE === 0 && FUNDER_ADDRESS) {
  console.warn("[Config] FUNDER_ADDRESS is ignored when SIGNATURE_TYPE=0 (EOA)");
}

if ((SIGNATURE_TYPE === 1 || SIGNATURE_TYPE === 2) && !FUNDER_ADDRESS) {
  console.error("[Config] FUNDER_ADDRESS is required when SIGNATURE_TYPE is 1 (POLY_PROXY) or 2 (GNOSIS_SAFE)");
  process.exit(1);
}

const EFFECTIVE_FUNDER_ADDRESS = SIGNATURE_TYPE === 0 ? null : FUNDER_ADDRESS;

const POLYGON_RPC_URL = envOrDefault("POLYGON_RPC_URL", "https://polygon-bor-rpc.publicnode.com");
const AUTO_APPROVE_COLLATERAL = parseBooleanEnv("AUTO_APPROVE_COLLATERAL", true);
const POLYGON_MIN_PRIORITY_FEE_GWEI = parseNumberEnv("POLYGON_MIN_PRIORITY_FEE_GWEI", "30");

const baseConfig = Object.freeze({
  PRIVATE_KEY: PRIVATE_KEY || null,
  FUNDER_ADDRESS,
  EFFECTIVE_FUNDER_ADDRESS,
  SIGNATURE_TYPE,
  POLYGON_RPC_URL,
  AUTO_APPROVE_COLLATERAL,
  POLYGON_MIN_PRIORITY_FEE_GWEI,
  CLOB_HOST: envOrDefault("CLOB_HOST", "https://clob.polymarket.com"),
  GAMMA_HOST: envOrDefault("GAMMA_HOST", "https://gamma-api.polymarket.com"),
  CHAIN_ID: parseNumberEnv("CHAIN_ID", "137", (value) => parseInt(value, 10)),
  FILTER_PROFILE: envOrDefault("FILTER_PROFILE", "historical_winners"),
  ORDER_PRICE: parseNumberEnv("ORDER_PRICE", "0.001"),
  ORDER_SIZE: parseNumberEnv("ORDER_SIZE", "100", (value) => parseInt(value, 10)),
  POST_ONLY: parseBooleanEnv("POST_ONLY", true),
  STRICT_ORDERBOOK_CHECK: parseBooleanEnv("STRICT_ORDERBOOK_CHECK", true),
  ORDER_BATCH_SIZE: parseNumberEnv("ORDER_BATCH_SIZE", "10", (value) => parseInt(value, 10)),
  ORDER_BATCH_MIN_SIZE: parseNumberEnv("ORDER_BATCH_MIN_SIZE", "1", (value) => parseInt(value, 10)),
  ORDER_BATCH_MAX_RETRIES: parseNumberEnv("ORDER_BATCH_MAX_RETRIES", "3", (value) => parseInt(value, 10)),
  ORDER_BATCH_RETRY_BASE_MS: parseNumberEnv("ORDER_BATCH_RETRY_BASE_MS", "1000", (value) => parseInt(value, 10)),
  DRY_RUN,
  RUN_FOREVER: parseBooleanEnv("RUN_FOREVER", false),
  SCAN_INTERVAL_MS: parseNumberEnv("SCAN_INTERVAL_MS", "3600000", (value) => parseInt(value, 10)),
  ORDER_DELAY_MS: parseNumberEnv("ORDER_DELAY_MS", "500", (value) => parseInt(value, 10)),
  SELL_SCAN_INTERVAL_MS: parseNumberEnv("SELL_SCAN_INTERVAL_MS", "180000", (value) => parseInt(value, 10)),
  PAGE_SIZE: parseNumberEnv("PAGE_SIZE", "100", (value) => parseInt(value, 10)),
  MAX_PAGES: parseNumberEnv("MAX_PAGES", "300", (value) => parseInt(value, 10)),
  FETCH_TIMEOUT_MS: parseNumberEnv("FETCH_TIMEOUT_MS", "15000", (value) => parseInt(value, 10)),
  STATE_FILE: envOrDefault("STATE_FILE", "scanner-state.json"),
  ERROR_LOG_FILE: envOrDefault("ERROR_LOG_FILE", "order-errors.jsonl"),
  STATE_CHANGE_LOG_FILE: envOrDefault("STATE_CHANGE_LOG_FILE", "state-changes.jsonl"),
  DISABLE_PROXY,
  PROXY_URL: DISABLE_PROXY ? null : proxyUrl || null,
});

const computedConfig = Object.freeze({
  ...baseConfig,
  MIN_SELL_SIZE: parseNumberEnv("MIN_SELL_SIZE", "1", (v) => parseInt(v, 10)),
  BUY_DEPTH_DEBOUNCE_MS: parseNumberEnv("BUY_DEPTH_DEBOUNCE_MS", "3000", (v) => parseInt(v, 10)),
  SELL_DEPTH_DEBOUNCE_MS: parseNumberEnv("SELL_DEPTH_DEBOUNCE_MS", "3000", (v) => parseInt(v, 10)),
  REPLACE_COOLDOWN_MS: parseNumberEnv("REPLACE_COOLDOWN_MS", "45000", (v) => parseInt(v, 10)),
  CIRCUIT_BREAKER_THRESHOLD: parseNumberEnv("CIRCUIT_BREAKER_THRESHOLD", "5", (v) => parseInt(v, 10)),
  MIN_MINUTES_TO_SETTLEMENT: parseNumberEnv("MIN_MINUTES_TO_SETTLEMENT", "60", (v) => parseInt(v, 10)),
});

export { computedConfig as config };
