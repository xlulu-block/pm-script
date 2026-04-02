import { config } from "./config.js";

const { GAMMA_HOST, PAGE_SIZE, MAX_PAGES, FETCH_TIMEOUT_MS, PROXY_URL, DISABLE_PROXY } = config;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatGammaNetworkError(err) {
  const causeCode = err?.cause?.code;
  const codeText = causeCode ? ` (${causeCode})` : "";

  if (PROXY_URL && !DISABLE_PROXY) {
    return `无法通过代理 ${PROXY_URL}${codeText} 访问 Gamma API。请检查代理是否正常运行，或在 .env 中设置 DISABLE_PROXY=true 以绕过代理。`;
  }

  return `无法访问 Gamma API${codeText}。如果你在中国或其他受限网络环境，请在 .env 中设置 HTTPS_PROXY，例如: HTTPS_PROXY=http://127.0.0.1:7890`;
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
      console.error(`[Gamma] 拉取 offset=${offset} 页面失败，尝试 ${attempt}/${retries}: ${detail}`);
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
    console.log(`[Gamma] 正在拉取市场数据，offset=${offset}...`);

    const markets = await fetchPage(offset);
    if (!Array.isArray(markets) || markets.length === 0) break;

    allMarkets.push(...markets);

    if (markets.length < PAGE_SIZE) break; // last page
    await sleep(200); // courtesy delay
  }

  if (allMarkets.length === MAX_PAGES * PAGE_SIZE) {
    console.warn(
      `[Gamma] 已达到配置上限（${MAX_PAGES} 页 / ${allMarkets.length} 个市场）。如果想扫描更多，请在 .env 中提高 MAX_PAGES。`
    );
  }

  console.log(`[Gamma] 活跃市场拉取完成，总数: ${allMarkets.length}`);
  return allMarkets;
}
