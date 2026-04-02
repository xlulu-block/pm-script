import { config } from "./config.js";

const { GAMMA_HOST, PAGE_SIZE, MAX_PAGES, FETCH_TIMEOUT_MS, PROXY_URL, DISABLE_PROXY } = config;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatGammaNetworkError(err) {
  const causeCode = err?.cause?.code;
  const codeText = causeCode ? ` (${causeCode})` : "";

  if (PROXY_URL && !DISABLE_PROXY) {
    return `Unable to reach Gamma API via proxy ${PROXY_URL}${codeText}. Check whether the proxy is running, or set DISABLE_PROXY=true in .env to bypass the proxy.`;
  }

  return `Unable to reach Gamma API${codeText}. If you are in China or another restricted network, set HTTPS_PROXY in .env, for example: HTTPS_PROXY=http://127.0.0.1:7890`;
}

async function fetchPage(offset, retries = 3) {
  const url = `${GAMMA_HOST}/markets?active=true&closed=false&limit=${PAGE_SIZE}&offset=${offset}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "pm-scanner/1.0",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Gamma API ${res.status}: ${await res.text()}`);
      }
      return await res.json();
    } catch (err) {
      const causeCode = err?.cause?.code;
      const detail = causeCode ? `${err.message} (${causeCode})` : err.message;
      console.error(`[Gamma] Page offset=${offset} attempt ${attempt}/${retries} failed: ${detail}`);
      if (attempt === retries) {
        throw new Error(formatGammaNetworkError(err), { cause: err });
      }
      await sleep(2000);
    }
  }
}

export async function fetchAllActiveMarkets() {
  const allMarkets = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    console.log(`[Gamma] Fetching markets offset=${offset}...`);

    const markets = await fetchPage(offset);
    if (!Array.isArray(markets) || markets.length === 0) break;

    allMarkets.push(...markets);

    if (markets.length < PAGE_SIZE) break; // last page
    await sleep(200); // courtesy delay
  }

  if (allMarkets.length === MAX_PAGES * PAGE_SIZE) {
    console.warn(
      `[Gamma] Reached configured cap (${MAX_PAGES} pages / ${allMarkets.length} markets). Increase MAX_PAGES in .env if you want to scan more.`
    );
  }

  console.log(`[Gamma] Total active markets fetched: ${allMarkets.length}`);
  return allMarkets;
}
