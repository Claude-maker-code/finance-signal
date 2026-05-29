import { TICKER_TO_COMPANY } from "../shared/constants.js";

/**
 * Parses raw HTML from Yahoo Finance latest-news page into a normalized Article array.
 * @param {string} html - Raw HTML string from the fetch response
 * @returns {Article[]}
 *
 * @typedef {Object} Article
 * @property {string} headline
 * @property {string} summary
 * @property {number} publishedAt - Unix timestamp in milliseconds
 * @property {string[]} tickers - Array of ticker symbols found in this article
 * @property {string} sourceUrl
 * @property {string} source - Publisher name
 */
export function parseNewsPage(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const articles = [];

  // Yahoo Finance renders news items in several possible container patterns across their A/B layouts
  const candidateSelectors = [
    'li[class*="stream-item"]',
    'div[class*="Ov(h)"]',
    'div[data-test="story-item"]',
    'article',
    'div[class*="news-stream"] li',
    'ul[class*="stream"] > li'
  ];

  let newsItems = [];
  for (const selector of candidateSelectors) {
    const found = Array.from(doc.querySelectorAll(selector));
    if (found.length > 0) {
      newsItems = found;
      break;
    }
  }

  // Fallback: grab all anchor tags that look like article links
  if (newsItems.length === 0) {
    newsItems = extractArticlesFromLinks(doc);
    return newsItems;
  }

  for (const item of newsItems) {
    const article = extractArticleFromElement(item);
    if (article) {
      articles.push(article);
    }
  }

  return deduplicateArticles(articles);
}

/**
 * Extracts article data from a single DOM element.
 * @param {Element} element
 * @returns {Article|null}
 */
function extractArticleFromElement(element) {
  const headlineEl = element.querySelector(
    "h3, h2, [class*='headline'], [class*='title'], a[class*='title']"
  );
  const linkEl = element.querySelector("a[href]");
  const summaryEl = element.querySelector(
    "p, [class*='summary'], [class*='description']"
  );
  const timeEl = element.querySelector("time, [class*='time'], [datetime]");

  if (!headlineEl && !linkEl) {
    return null;
  }

  const headline = (headlineEl || linkEl).textContent.trim();
  if (!headline || headline.length < 10) {
    return null;
  }

  const rawHref = linkEl ? linkEl.getAttribute("href") : "";
  const sourceUrl = normalizeUrl(rawHref);
  const summary = summaryEl ? summaryEl.textContent.trim() : "";
  const publishedAt = parseTimestamp(timeEl);
  const tickers = extractTickersFromText(headline + " " + summary);

  return {
    headline,
    summary,
    publishedAt,
    tickers,
    sourceUrl,
    source: extractSourceName(element)
  };
}

/**
 * Fallback parser: scans all <a> tags for article-like links.
 * @param {Document} doc
 * @returns {Article[]}
 */
function extractArticlesFromLinks(doc) {
  const articles = [];
  const anchors = Array.from(doc.querySelectorAll("a[href]"));

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    const text = anchor.textContent.trim();

    // Only keep links that look like article links (have meaningful text, link to news)
    const isNewsLink =
      text.length > 20 &&
      (href.includes("/news/") ||
        href.includes("finance.yahoo.com") ||
        href.startsWith("/") ||
        href.includes("-") && href.length > 30);

    if (!isNewsLink) {
      continue;
    }

    const tickers = extractTickersFromText(text);
    articles.push({
      headline: text,
      summary: "",
      publishedAt: Date.now(),
      tickers,
      sourceUrl: normalizeUrl(href),
      source: "Yahoo Finance"
    });
  }

  return deduplicateArticles(articles);
}

/**
 * Extracts known ticker symbols from a text string.
 * Uses the TICKER_TO_COMPANY map plus a pattern for all-caps 1-5 letter sequences in parentheses.
 * @param {string} text
 * @returns {string[]}
 */
export function extractTickersFromText(text) {
  const found = new Set();

  // Pattern 1: explicit parenthetical tickers like (AAPL) or (NYSE: AAPL) or (NASDAQ: NVDA)
  const parenPattern = /\((?:NYSE|NASDAQ|AMEX|BATS|OTC):\s*([A-Z]{1,5})\)/g;
  let match;
  while ((match = parenPattern.exec(text)) !== null) {
    found.add(match[1]);
  }

  // Pattern 2: bare parenthetical all-caps, e.g. (AAPL)
  const bareParenPattern = /\(([A-Z]{1,5})\)/g;
  while ((match = bareParenPattern.exec(text)) !== null) {
    const ticker = match[1];
    if (TICKER_TO_COMPANY[ticker]) {
      found.add(ticker);
    }
  }

  // Pattern 3: standalone all-caps words that match known tickers
  const wordPattern = /\b([A-Z]{1,5})\b/g;
  while ((match = wordPattern.exec(text)) !== null) {
    const candidate = match[1];
    if (TICKER_TO_COMPANY[candidate]) {
      found.add(candidate);
    }
  }

  return Array.from(found);
}

/**
 * Parses a timestamp from a time element. Returns current time if parsing fails.
 * @param {Element|null} timeEl
 * @returns {number} Unix timestamp in milliseconds
 */
function parseTimestamp(timeEl) {
  if (!timeEl) {
    return Date.now();
  }

  const datetime = timeEl.getAttribute("datetime") || timeEl.textContent.trim();
  if (!datetime) {
    return Date.now();
  }

  const parsed = Date.parse(datetime);
  if (!isNaN(parsed)) {
    return parsed;
  }

  // Handle relative timestamps like "2 hours ago", "30 minutes ago"
  const relativeMatch = datetime.match(/(\d+)\s+(minute|hour|day|hour)s?\s+ago/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const unitMs = { minute: 60000, hour: 3600000, day: 86400000 }[unit] || 3600000;
    return Date.now() - amount * unitMs;
  }

  return Date.now();
}

/**
 * Normalizes a URL that may be relative (Yahoo Finance internal) to absolute.
 * @param {string} href
 * @returns {string}
 */
function normalizeUrl(href) {
  if (!href) {
    return "";
  }
  if (href.startsWith("http")) {
    return href;
  }
  if (href.startsWith("//")) {
    return "https:" + href;
  }
  if (href.startsWith("/")) {
    return "https://finance.yahoo.com" + href;
  }
  return href;
}

/**
 * Attempts to extract a publisher/source name from the article container.
 * @param {Element} element
 * @returns {string}
 */
function extractSourceName(element) {
  const sourceEl = element.querySelector(
    "[class*='provider'], [class*='source'], [class*='publisher'], figcaption"
  );
  if (sourceEl) {
    return sourceEl.textContent.trim();
  }
  return "Yahoo Finance";
}

/**
 * Removes duplicate articles by normalizing and comparing headlines.
 * @param {Article[]} articles
 * @returns {Article[]}
 */
function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const normalized = article.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}
