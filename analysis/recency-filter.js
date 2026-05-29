import { MAX_ARTICLE_AGE_MS } from "../shared/constants.js";

/**
 * Filters an array of articles to only those published within the last 72 hours.
 * Articles outside this window are never passed to the signal engine.
 *
 * @param {import("./news-parser.js").Article[]} articles
 * @param {number} [nowMs] - Override for current time (used in tests)
 * @returns {import("./news-parser.js").Article[]}
 */
export function filterToRecentArticles(articles, nowMs = Date.now()) {
  const cutoff = nowMs - MAX_ARTICLE_AGE_MS;
  return articles.filter(article => article.publishedAt >= cutoff);
}

/**
 * Returns a human-readable label for how long ago an article was published.
 * @param {number} publishedAt - Unix timestamp in milliseconds
 * @param {number} [nowMs] - Override for current time (used in tests)
 * @returns {string}
 */
export function formatRelativeTime(publishedAt, nowMs = Date.now()) {
  const diffMs = nowMs - publishedAt;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) {
    return "just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}
