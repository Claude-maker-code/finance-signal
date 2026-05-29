import { SIGNAL_THRESHOLD, TICKER_TO_COMPANY } from "../shared/constants.js";
import { scoreArticles } from "./sentiment.js";

/**
 * @typedef {Object} Signal
 * @property {string} signalId - Unique ID: "{ticker}-{generatedAt ISO}"
 * @property {string} ticker
 * @property {string} companyDescription - Plain-English company description
 * @property {"BUY"|"SELL"} action
 * @property {number} confidence - 0–100
 * @property {string} reason - Plain-English explanation
 * @property {SupportingArticle[]} supportingArticles
 * @property {number} generatedAt - Unix timestamp in milliseconds
 */

/**
 * @typedef {Object} SupportingArticle
 * @property {string} headline
 * @property {number} publishedAt
 * @property {string} sourceUrl
 * @property {string} source
 * @property {string[]} matchedKeywords
 * @property {number} score
 */

/**
 * Aggregates scored articles by ticker and emits one Signal per ticker
 * that exceeds the signal threshold.
 *
 * @param {import("./news-parser.js").Article[]} articles - Already filtered to 72h window
 * @returns {Signal[]}
 */
export function generateSignals(articles) {
  const scoredArticles = scoreArticles(articles);

  // Group scored articles by ticker
  const byTicker = new Map();
  for (const scored of scoredArticles) {
    if (!byTicker.has(scored.ticker)) {
      byTicker.set(scored.ticker, []);
    }
    byTicker.get(scored.ticker).push(scored);
  }

  const signals = [];
  const generatedAt = Date.now();

  for (const [ticker, tickerArticles] of byTicker) {
    const aggregateScore = tickerArticles.reduce((sum, a) => sum + a.score, 0);

    // Skip neutral or below-threshold signals
    if (Math.abs(aggregateScore) < SIGNAL_THRESHOLD) {
      continue;
    }

    const action = aggregateScore > 0 ? "BUY" : "SELL";
    const confidence = calculateConfidence(aggregateScore, tickerArticles.length);
    const companyDescription = TICKER_TO_COMPANY[ticker] || ticker;
    const reason = buildReason(action, ticker, tickerArticles, aggregateScore);

    const supportingArticles = tickerArticles
      .filter(a => a.direction !== "NEUTRAL")
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .map(a => ({
        headline: a.headline,
        publishedAt: a.publishedAt,
        sourceUrl: a.sourceUrl,
        source: a.source,
        matchedKeywords: a.matchedKeywords,
        score: a.score
      }));

    signals.push({
      signalId: `${ticker}-${new Date(generatedAt).toISOString()}`,
      ticker,
      companyDescription,
      action,
      confidence,
      reason,
      supportingArticles,
      generatedAt
    });
  }

  // Sort: highest confidence first
  return signals.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Calculates a confidence score (0–100) based on aggregate score magnitude and article count.
 * Formula: min(100, |aggregateScore| * 10 + articleCount * 5)
 * This keeps confidence honest — a single mildly-bullish headline can only reach ~15%.
 *
 * @param {number} aggregateScore
 * @param {number} articleCount
 * @returns {number}
 */
function calculateConfidence(aggregateScore, articleCount) {
  const raw = Math.abs(aggregateScore) * 10 + articleCount * 5;
  return Math.min(100, Math.round(raw));
}

/**
 * Builds a plain-English reason string for a signal.
 * @param {"BUY"|"SELL"} action
 * @param {string} ticker
 * @param {import("./sentiment.js").ScoredArticle[]} articles
 * @param {number} aggregateScore
 * @returns {string}
 */
function buildReason(action, ticker, articles, aggregateScore) {
  const count = articles.length;
  const articleWord = count === 1 ? "article" : "articles";

  // Collect all unique matched keywords across articles
  const allKeywords = new Set(articles.flatMap(a => a.matchedKeywords));
  const keywordList = Array.from(allKeywords).slice(0, 4).join(", ");

  // Compute date range of supporting articles
  const timestamps = articles.map(a => a.publishedAt);
  const oldest = new Date(Math.min(...timestamps));
  const newest = new Date(Math.max(...timestamps));

  const dateRange = oldest.toDateString() === newest.toDateString()
    ? formatDate(oldest)
    : `${formatDate(oldest)} – ${formatDate(newest)}`;

  const directionWord = action === "BUY" ? "positive" : "negative";
  const oppositeCount = articles.filter(a =>
    action === "BUY" ? a.direction === "SELL" : a.direction === "BUY"
  ).length;

  let reason = `${count} ${articleWord} from the last 72 hours carry ${directionWord} signals`;

  if (keywordList) {
    reason += `, including: ${keywordList}`;
  }

  reason += `. Published: ${dateRange}.`;

  if (oppositeCount > 0) {
    reason += ` Note: ${oppositeCount} article${oppositeCount > 1 ? "s" : ""} contain conflicting signals.`;
  }

  return reason;
}

/**
 * Formats a Date as a short readable string.
 * @param {Date} date
 * @returns {string}
 */
function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
