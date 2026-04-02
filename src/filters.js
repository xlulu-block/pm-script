import { config } from "./config.js";

const CRYPTO_EVENT_REGEX =
  /\b(bitcoin|btc|ethereum|eth\b|ether\b|solana|sol\b|dogecoin|doge|xrp|ripple|cardano|ada\b|bnb\b|crypto|cryptocurrency|token\b|tokens\b|memecoin|stablecoin|altcoin|defi|nft|web3|onchain|blockchain)\b/i;

const ANNUAL_EVENT_REGEX =
  /\b(calendar year|year-end|year end|end of year|by year end|annual|yearly|full year|full-year|fy ?20\d{2}|by december 31|by end of|end of 20\d{2}|this year)\b/i;

const LEGACY_RULES = [
  {
    key: "WEATHER",
    test: (text) =>
      /\b(weather|temperature|forecast|rain|rainy|snow|snowy|snowfall|rainfall|hurricane|tornado|storm|heatwave|heat\s+wave|blizzard|flood|drought|typhoon|cyclone|precipitation|degrees|fahrenheit|celsius)\b/i.test(
        text
      ),
  },
  {
    key: "TRUMP_SPEECH",
    test: (text) =>
      /\b(donald\s+trump|trump)\b/i.test(text) &&
      /\b(say|says|said|speak|speaks|spoke|speech|remark|remarks|comment|comments|statement|interview|mention|mentions|address|addresses|announce|announced|announcement)\b/i.test(
        text
      ),
  },
  {
    key: "MUSK_TWEET",
    test: (text) =>
      /\b(elon\s+musk|elon|musk)\b/i.test(text) &&
      /\b(tweet|tweets|tweeted|tweeting|post|posts|posted|posting|x\s+post|on\s+x|on\s+twitter|twitter|retweet|quote\s+tweet)\b/i.test(
        text
      ),
  },
];

const HISTORICAL_WINNER_RULES = [
  {
    key: "ELON_TWEET_COUNT",
    test: (text) =>
      /\bwill elon musk post\b/i.test(text) &&
      /\btweets?\b/i.test(text),
  },
  {
    key: "TRUMP_SAY_PHRASE",
    test: (text) => /\bwill trump say\b/i.test(text),
  },
  {
    key: "TEMPERATURE_EXACT_RANGE",
    test: (text) => /\bhighest temperature\b/i.test(text),
  },
  {
    key: "MARKET_UP_DOWN",
    test: (text) => /\b(opens up or down|up or down)\b/i.test(text),
  },
  {
    key: "EARNINGS_BEAT",
    test: (text) => /\bbeat quarterly earnings\b/i.test(text),
  },
  {
    key: "IPO_MARKET_CAP_RANGE",
    test: (text) =>
      /\bmarket cap\b/i.test(text) && /\bipo day\b/i.test(text),
  },
  {
    key: "ELECTION_TURNOUT_RANGE",
    test: (text) =>
      /\bturnout\b/i.test(text) &&
      /\bbetween\b/i.test(text),
  },
];

const EXTREME_REVERSAL_RULES = [
  {
    key: "FED_RATE_DECISION",
    test: (text) =>
      /\b(fed|federal reserve|fomc|interest rate|rate cut|rate hike|basis points|bps|powell)\b/i.test(text) &&
      /\b(decision|meeting|announce|cut|hike|hold|pause)\b/i.test(text),
  },
  {
    key: "GEOPOLITICAL_CONFLICT",
    test: (text) =>
      /\b(war|conflict|military|invasion|strike|attack|ceasefire|peace deal|iran|israel|ukraine|russia|china|taiwan)\b/i.test(text),
  },
  {
    key: "OIL_PRICE_RANGE",
    test: (text) =>
      /\b(oil|crude|wti|brent|opec|barrel)\b/i.test(text) &&
      /\b(price|hit|reach|above|below)\b/i.test(text),
  },
  {
    key: "INFLATION_DATA",
    test: (text) =>
      /\b(cpi|pce|inflation|consumer price)\b/i.test(text) &&
      /\b(above|below|between|higher|lower)\b/i.test(text),
  },
  {
    key: "RECESSION_PROBABILITY",
    test: (text) =>
      /\b(recession|economic downturn|gdp contraction)\b/i.test(text),
  },
  {
    key: "SPORTS_OUTCOME",
    test: (text) =>
      /\b(nfl|nba|nhl|mlb|mma|ufc|super bowl|playoffs|championship|win|lose|score)\b/i.test(text),
  },
  {
    key: "BOX_OFFICE_RANGE",
    test: (text) =>
      /\b(box office|opening weekend|gross|ticket sales)\b/i.test(text) &&
      /\b(million|billion|above|below|between)\b/i.test(text),
  },
  {
    key: "AWARDS_WINNER",
    test: (text) =>
      /\b(oscar|academy award|grammy|emmy|golden globe|best picture|best actor)\b/i.test(text) &&
      /\b(win|winner|award)\b/i.test(text),
  },
];

const FILTER_PROFILES = {
  legacy: LEGACY_RULES,
  historical_winners: HISTORICAL_WINNER_RULES,
  extreme_reversal: EXTREME_REVERSAL_RULES,
};

const PROFILE_BEHAVIORS = {
  legacy: {
    scanAll: false,
    excludeAnnual: true,
    excludeCrypto: true,
  },
  historical_winners: {
    scanAll: true,
    excludeAnnual: false,
    excludeCrypto: false,
  },
  extreme_reversal: {
    scanAll: false,
    excludeAnnual: true,
    excludeCrypto: true,
  },
};

function parseArrayish(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectPrimaryText(market) {
  const eventTitles = Array.isArray(market.events)
    ? market.events.map((event) => event?.title).filter(Boolean)
    : [];

  return [market.question, market.groupItemTitle, market.slug, ...eventTitles]
    .filter(Boolean)
    .join(" ");
}

function getEventTitle(market) {
  if (Array.isArray(market.events) && market.events.length > 0) {
    return market.events[0]?.title || null;
  }
  return null;
}

function parseYesTokenID(market) {
  if (Array.isArray(market.tokens)) {
    const yesToken = market.tokens.find(
      (token) => token.outcome && token.outcome.toLowerCase() === "yes"
    );
    if (yesToken?.token_id) return yesToken.token_id;
    if (yesToken?.tokenId) return yesToken.tokenId;
  }

  const tokenIDs =
    parseArrayish(market.clobTokenIds) || parseArrayish(market.clob_token_ids);
  if (!Array.isArray(tokenIDs) || tokenIDs.length === 0) return null;

  const outcomes = parseArrayish(market.outcomes);
  if (Array.isArray(outcomes)) {
    const yesIndex = outcomes.findIndex(
      (outcome) =>
        typeof outcome === "string" && outcome.toLowerCase() === "yes"
    );
    if (yesIndex >= 0 && tokenIDs[yesIndex]) {
      return tokenIDs[yesIndex];
    }
  }

  return tokenIDs[0] || null;
}

function getActiveRules() {
  return FILTER_PROFILES[config.FILTER_PROFILE] || FILTER_PROFILES.historical_winners;
}

function getProfileBehavior() {
  return PROFILE_BEHAVIORS[config.FILTER_PROFILE] || PROFILE_BEHAVIORS.historical_winners;
}

export function filterMarkets(markets) {
  const rules = getActiveRules();
  const behavior = getProfileBehavior();
  const counts = behavior.scanAll
    ? { ALL_MARKETS: 0 }
    : Object.fromEntries(rules.map((rule) => [rule.key, 0]));
  const excludedCounts = {
    annual: 0,
    crypto: 0,
    nearSettlement: 0,
    paused: 0,
    noVolume: 0,
  };
  const seenTokenIDs = new Set();
  const allTargets = [];
  const now = Date.now();
  const settlementCutoffMs = config.MIN_MINUTES_TO_SETTLEMENT * 60000;

  for (const market of markets) {
    const primaryText = collectPrimaryText(market);
    if (!primaryText) continue;

    if (behavior.excludeAnnual && ANNUAL_EVENT_REGEX.test(primaryText)) {
      excludedCounts.annual++;
      continue;
    }

    if (behavior.excludeCrypto && CRYPTO_EVENT_REGEX.test(primaryText)) {
      excludedCounts.crypto++;
      continue;
    }

    // Exclude paused / disputed / non-tradable markets
    if (market.active === false || market.closed === true || market.accepting_orders === false) {
      excludedCounts.paused++;
      continue;
    }

    // Exclude markets near settlement
    const endDate = market.end_date_iso || market.endDate;
    if (endDate) {
      const msToSettlement = new Date(endDate).getTime() - now;
      if (msToSettlement > 0 && msToSettlement < settlementCutoffMs) {
        excludedCounts.nearSettlement++;
        continue;
      }
    }

    // Exclude 24h no-volume markets
    if (Number(market.volume_num_24hr || 0) === 0 && Number(market.liquidity || 0) === 0) {
      excludedCounts.noVolume++;
      continue;
    }

    const tokenID = parseYesTokenID(market);
    if (!tokenID) continue;

    const categories = [];
    if (behavior.scanAll) {
      counts.ALL_MARKETS++;
      categories.push("ALL_MARKETS");
    } else {
      for (const rule of rules) {
        if (rule.test(primaryText)) {
          counts[rule.key]++;
          categories.push(rule.key);
        }
      }
    }

    if (categories.length > 0 && !seenTokenIDs.has(tokenID)) {
      seenTokenIDs.add(tokenID);
      allTargets.push({
        tokenID,
        question: market.question || market.groupItemTitle || market.slug || market.id,
        category: categories.join("+"),
        slug: market.slug || null,
        groupItemTitle: market.groupItemTitle || null,
        eventTitle: getEventTitle(market),
        endDate: endDate || null,
      });
    }
  }

  const summary = Object.entries(counts)
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
  const excludedSummary = Object.entries(excludedCounts)
    .map(([key, count]) => `${key}: ${count}`)
    .join(", ");
  console.log(
    `[Filter] Profile=${config.FILTER_PROFILE}, ${summary}, Excluded: ${excludedSummary}, Unique targets: ${allTargets.length}`
  );

  return { categoryCounts: counts, excludedCounts, allTargets };
}
