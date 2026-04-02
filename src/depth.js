export const DEPTH_MULTIPLIER = 3;
export const PRICE_DECIMALS = 3;

export function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return null;
  return price.toFixed(PRICE_DECIMALS);
}

export function getBuyPriceLevel(cfg) {
  return formatPrice(cfg?.ORDER_PRICE || 0);
}

export function getTargetSellPrice(cfg) {
  return formatPrice(Number(cfg?.ORDER_PRICE || 0) * 2);
}

export function analyzeBidDepth(orderBook, cfg) {
  const buyPriceLevel = getBuyPriceLevel(cfg);
  const result = {
    bidSharesAtBuyPrice: 0,
    buyPriceLevel,
    targetSellPrice: getTargetSellPrice(cfg),
    hasAnyBids: false,
    hasAnyAsks: false,
  };

  if (!orderBook) return result;

  const bids = orderBook.bids;
  const asks = orderBook.asks;

  if (Array.isArray(asks)) {
    result.hasAnyAsks = asks.some((l) => Number(l?.size || 0) > 0);
  }

  if (!Array.isArray(bids)) return result;

  for (const level of bids) {
    const size = Number(level?.size || 0);
    if (size <= 0) continue;
    result.hasAnyBids = true;
    const price = String(level?.price || "");
    if (price === buyPriceLevel) {
      result.bidSharesAtBuyPrice += size;
    }
  }

  return result;
}

export function getDepthThreshold(cfg) {
  return DEPTH_MULTIPLIER * Number(cfg?.ORDER_SIZE || 0);
}

export function shouldBuy(depth, cfg) {
  if (!depth.hasAnyBids) return false;
  if (depth.bidSharesAtBuyPrice < getDepthThreshold(cfg)) return false;
  return true;
}

export function decideSellPrice(depth, cfg) {
  return depth.bidSharesAtBuyPrice < getDepthThreshold(cfg)
    ? getBuyPriceLevel(cfg)
    : getTargetSellPrice(cfg);
}

export function shouldForceExit(depth, cfg) {
  return depth.bidSharesAtBuyPrice < getDepthThreshold(cfg);
}
