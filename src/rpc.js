import { ethers } from "ethers";
import { config } from "./config.js";

const POLYGON_NETWORK = Object.freeze({
  name: "matic",
  chainId: 137,
});

const POLYGON_RPC_FALLBACKS = Object.freeze([
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://1rpc.io/matic",
]);

let cachedRpcResolution = null;

function truncate(value, maxLength = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function parseChainId(value) {
  if (typeof value === "string") {
    if (value.startsWith("0x")) {
      return Number.parseInt(value, 16);
    }
    return Number.parseInt(value, 10);
  }

  if (typeof value === "number") {
    return value;
  }

  return Number.NaN;
}

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function probePolygonRpcUrl(rpcUrl) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
    signal: AbortSignal.timeout(config.FETCH_TIMEOUT_MS),
  });

  const bodyText = await response.text();
  let payload = null;

  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.error?.message || bodyText || response.statusText;
    throw new Error(`HTTP ${response.status}: ${truncate(detail)}`);
  }

  if (payload?.error) {
    const codeText = payload.error.code !== undefined ? ` ${payload.error.code}` : "";
    throw new Error(`JSON-RPC${codeText}: ${truncate(payload.error.message || JSON.stringify(payload.error))}`);
  }

  const chainId = parseChainId(payload?.result);
  if (chainId !== POLYGON_NETWORK.chainId) {
    throw new Error(`returned unexpected chainId ${payload?.result ?? "unknown"}`);
  }

  return {
    rpcUrl,
    chainId,
  };
}

export function getPolygonRpcCandidates(preferredRpcUrl = config.POLYGON_RPC_URL) {
  return uniqueNonEmpty([preferredRpcUrl, ...POLYGON_RPC_FALLBACKS]);
}

export async function resolvePolygonRpc(preferredRpcUrl = config.POLYGON_RPC_URL) {
  if (cachedRpcResolution?.preferredRpcUrl === preferredRpcUrl) {
    return cachedRpcResolution.result;
  }

  const candidates = getPolygonRpcCandidates(preferredRpcUrl);
  const failures = [];

  for (const rpcUrl of candidates) {
    try {
      const result = await probePolygonRpcUrl(rpcUrl);
      cachedRpcResolution = {
        preferredRpcUrl,
        result,
      };
      return result;
    } catch (error) {
      failures.push({
        rpcUrl,
        reason: error.message || String(error),
      });
    }
  }

  const detail = failures.map((entry) => `${entry.rpcUrl} -> ${entry.reason}`).join("; ");
  throw new Error(`No working Polygon RPC endpoint found. ${detail}`);
}

export async function getPolygonProvider(preferredRpcUrl = config.POLYGON_RPC_URL) {
  const { rpcUrl } = await resolvePolygonRpc(preferredRpcUrl);
  const provider = new ethers.providers.StaticJsonRpcProvider(
    {
      url: rpcUrl,
      timeout: config.FETCH_TIMEOUT_MS,
    },
    POLYGON_NETWORK
  );

  return {
    rpcUrl,
    provider,
    network: POLYGON_NETWORK,
  };
}
