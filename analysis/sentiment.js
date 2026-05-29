import { BULLISH_KEYWORDS, BEARISH_KEYWORDS, MAGNITUDE_MODIFIERS } from "../shared/constants.js";

/**
 * @typedef {Object} ScoredArticle
 * @property {string} ticker
 * @property {number} score - Positive = bullish, negative = bearish
 * @property {"BUY"|"SELL"|"NEUTRAL"} direction
 * @property {string} headline
 * @property {string} summary
 * @property {number} publishedAt
 * @property {string} sourceUrl
 * @property {string} source
 * @property {string[]} matchedKeywords - Keywords that contributed to the score
 */

/**
 * Scores all articles that carry at least one ticker and returns a flat array
 * of ScoredArticle entries (one per ticker per article).
 *
 * @param {import("./news-parser.js").Article[]} articles
 * @returns {ScoredArticle[]}
 */
export function scoreArticles(articles) {
  const results = [];

  for (const article of articles) {
    if (article.tickers.length === 0) {
      continue;
    }

    const { score, matchedKeywords } = scoreText(article.headline + " " + article.summary);

    const direction = score > 0 ? "BUY" : score < 0 ? "SELL" : "NEUTRAL";

    for (const ticker of article.tickers) {
      results.push({
        ticker,
        score,
        direction,
        headline: article.headline,
        summary: article.summary,
        publishedAt: article.publishedAt,
        sourceUrl: article.sourceUrl,
        source: article.source,
        matchedKeywords
      });
    }
  }

  return results;
}

/**
 * Scores a text string using bullish/bearish keyword maps and magnitude modifiers.
 * Returns a numeric score and the list of keywords that were matched.
 *
 * @param {string} text
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
export function scoreText(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const matchedKeywords = [];

  // Amplifiers (> 1.0) and dampeners (< 1.0) are tracked separately.
  // The strongest amplifier wins if present; otherwise the strongest dampener applies.
  // This ensures "slightly beats" is dampened while "significantly beats" is amplified.
  let amplifier = 1.0;
  let dampener = 1.0;
  for (const [modifier, multiplier] of Object.entries(MAGNITUDE_MODIFIERS)) {
    if (lower.includes(modifier)) {
      if (multiplier >= 1.0) {
        amplifier = Math.max(amplifier, multiplier);
      } else {
        dampener = Math.min(dampener, multiplier);
      }
    }
  }
  const activeMagnitude = amplifier > 1.0 ? amplifier : dampener;

  for (const [keyword, weight] of Object.entries(BULLISH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      score += weight * activeMagnitude;
      matchedKeywords.push(keyword);
    }
  }

  for (const [keyword, weight] of Object.entries(BEARISH_KEYWORDS)) {
    if (lower.includes(keyword)) {
      score += weight * activeMagnitude;
      matchedKeywords.push(keyword);
    }
  }

  return { score: parseFloat(score.toFixed(2)), matchedKeywords };
}
