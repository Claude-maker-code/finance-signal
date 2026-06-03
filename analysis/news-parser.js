import { TICKER_TO_COMPANY } from "../shared/constants.js";

/**
 * Parses raw HTML from any Yahoo Finance page into a normalized Article array.
 * Tries structured selectors first; falls back to harvesting all /news/ links.
 *
 * @param {string} html - Raw HTML string
 * @returns {Article[]}
 *
 * @typedef {Object} Article
 * @property {string} headline
 * @property {string} summary
 * @property {number} publishedAt - Unix timestamp in milliseconds
 * @property {string[]} tickers
 * @property {string} sourceUrl
 * @property {string} source
 */
export function parseNewsPage(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Try selectors from most specific to most generic.
  // A selector is only accepted if it yields at least 2 valid articles —
  // this prevents a single mis-matched element (e.g. a featured article on
  // the homepage matching `article`) from blocking the fallback path.
  const candidateSelectors = [
    'li[class*="stream-item"]',
    'div[data-test="story-item"]',
    '[data-testid*="news-card"]',
    '[data-testid*="article"]',
    'div[class*="Ov(h)"]',
    'div[class*="news-stream"] li',
    'ul[class*="stream"] > li',
    'article'
  ];

  for (const selector of candidateSelectors) {
    const found = Array.from(doc.querySelectorAll(selector));
    if (found.length === 0) continue;

    const articles = found
      .map(extractArticleFromElement)
      .filter(Boolean);

    // Only trust this selector if it produced real results
    if (articles.length >= 2) {
      return deduplicateArticles(articles);
    }
  }

  // Fallback: harvest all /news/ links from the page.
  // Works on any Yahoo Finance page layout including the homepage.
  return extractArticlesFromLinks(doc);
}

/**
 * Extracts article data from a single structured DOM element.
 * @param {Element} element
 * @returns {Article|null}
 */
function extractArticleFromElement(element) {
  const headlineEl = element.querySelector(
    "h3, h2, h1, [class*='headline'], [class*='title'], a[class*='title']"
  );
  const linkEl = element.querySelector("a[href]");

  if (!headlineEl && !linkEl) return null;

  const headline = (headlineEl || linkEl).textContent.trim();
  if (!headline || headline.length < 10) return null;

  // Ignore navigation / UI elements that slip through
  if (/^(sign in|log in|my portfolio|markets|news|finance|sports|more)$/i.test(headline)) {
    return null;
  }

  const rawHref = linkEl ? linkEl.getAttribute("href") : "";
  const sourceUrl = normalizeUrl(rawHref);

  // Only keep links that point to actual articles
  if (sourceUrl && !sourceUrl.includes("/news/") && !sourceUrl.includes("finance.yahoo.com")) {
    return null;
  }

  const summaryEl = element.querySelector(
    "p, [class*='summary'], [class*='description'], [class*='excerpt']"
  );
  const summary = summaryEl ? summaryEl.textContent.trim() : "";

  const timeEl = element.querySelector("time, [datetime], [class*='time'], [class*='date']");
  const publishedAt = parseTimestamp(timeEl, element);

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
 * Fallback: scans the document for all links whose href contains "/news/".
 * Works reliably on any Yahoo Finance page layout (homepage, topic pages, etc.).
 * @param {Document} doc
 * @returns {Article[]}
 */
function extractArticlesFromLinks(doc) {
  const articles = [];

  // Target only links that point to news articles
  const anchors = Array.from(doc.querySelectorAll('a[href*="/news/"]'));

  for (const anchor of anchors) {
    const href = anchor.getAttribute("href") || "";
    const text = anchor.textContent.trim();

    // Must have a real headline
    if (text.length < 15) continue;

    // Skip nav/tab-style links that share the /news/ path
    if (/^(news|latest|trending|all)$/i.test(text)) continue;

    const sourceUrl = normalizeUrl(href);
    const publishedAt = extractNearbyTimestamp(anchor);
    const source = extractNearbySource(anchor);
    const tickers = extractTickersFromText(text);

    articles.push({ headline: text, summary: "", publishedAt, tickers, sourceUrl, source });
  }

  return deduplicateArticles(articles);
}

// ─── Timestamp helpers ────────────────────────────────────────────────────────

/**
 * Extracts a timestamp from a time element, with a fallback that searches
 * nearby DOM for relative-time strings like "6m ago" or "4h ago".
 * @param {Element|null} timeEl
 * @param {Element|null} container - Parent container to search when timeEl is null
 * @returns {number}
 */
function parseTimestamp(timeEl, container = null) {
  if (timeEl) {
    const datetime = timeEl.getAttribute("datetime") || timeEl.textContent.trim();
    if (datetime) {
      const iso = Date.parse(datetime);
      if (!isNaN(iso)) return iso;

      const relative = parseRelativeTime(datetime);
      if (relative) return relative;
    }
  }

  // Search the surrounding container for relative time text
  if (container) {
    return extractNearbyTimestamp(container) || Date.now();
  }

  return Date.now();
}

/**
 * Walks up to 5 ancestor elements looking for a relative time string.
 * Handles both short ("6m ago", "2h ago") and long ("6 minutes ago") formats.
 * @param {Element} element
 * @returns {number}
 */
function extractNearbyTimestamp(element) {
  let el = element;
  for (let depth = 0; depth < 5; depth++) {
    if (!el) break;

    // Check for <time datetime="...">
    const timeEl = el.querySelector ? el.querySelector("time[datetime]") : null;
    if (timeEl) {
      const iso = Date.parse(timeEl.getAttribute("datetime"));
      if (!isNaN(iso)) return iso;
    }

    const text = el.textContent || "";
    const relative = parseRelativeTime(text);
    if (relative) return relative;

    el = el.parentElement;
  }
  return Date.now();
}

/**
 * Parses a relative time string into a Unix timestamp.
 * Handles: "6m ago", "4h ago", "2d ago", "6 minutes ago", "3 hours ago".
 * @param {string} text
 * @returns {number|null}
 */
function parseRelativeTime(text) {
  // Match both abbreviated ("6m ago") and full ("6 minutes ago") formats
  const match = text.match(
    /(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?r)?s?|d(?:ay)?s?)\s*ago/i
  );
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unitChar = match[2][0].toLowerCase();
  const msMap = { m: 60000, h: 3600000, d: 86400000 };
  return Date.now() - amount * (msMap[unitChar] || 3600000);
}

// ─── Source / URL helpers ─────────────────────────────────────────────────────

/**
 * Walks nearby elements to find a publisher name (e.g. "Reuters", "Bloomberg").
 * @param {Element} anchor
 * @returns {string}
 */
function extractNearbySource(anchor) {
  let el = anchor.parentElement;
  for (let depth = 0; depth < 4; depth++) {
    if (!el) break;

    const text = el.textContent.trim();

    // Pattern: "Reuters · 6m ago"  or  "Bloomberg • 4h ago"
    const sourceMatch = text.match(/^([A-Za-z][^·•·\n]{1,28}?)\s*[·•·]/);
    if (sourceMatch) {
      const candidate = sourceMatch[1].trim();
      if (candidate.length >= 2 && candidate.length <= 30) return candidate;
    }

    // Explicit source/provider element
    const sourceEl = el.querySelector(
      "[class*='provider'], [class*='source'], [class*='publisher']"
    );
    if (sourceEl) return sourceEl.textContent.trim();

    el = el.parentElement;
  }
  return "Yahoo Finance";
}

/**
 * Attempts to extract a publisher name from a structured article element.
 * @param {Element} element
 * @returns {string}
 */
function extractSourceName(element) {
  const sourceEl = element.querySelector(
    "[class*='provider'], [class*='source'], [class*='publisher'], figcaption"
  );
  if (sourceEl) return sourceEl.textContent.trim();
  return "Yahoo Finance";
}

/**
 * Normalizes a relative or protocol-relative URL to an absolute https URL.
 * @param {string} href
 * @returns {string}
 */
function normalizeUrl(href) {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return "https://finance.yahoo.com" + href;
  return href;
}

// ─── Ticker extraction ────────────────────────────────────────────────────────

/**
 * Extracts known ticker symbols from a text string.
 * @param {string} text
 * @returns {string[]}
 */
export function extractTickersFromText(text) {
  const found = new Set();

  // Pattern 1: exchange-qualified  (NYSE: AAPL)  (NASDAQ: NVDA)
  const exchangePattern = /\((?:NYSE|NASDAQ|AMEX|BATS|OTC):\s*([A-Z]{1,5})\)/g;
  let match;
  while ((match = exchangePattern.exec(text)) !== null) found.add(match[1]);

  // Pattern 2: bare parenthetical  (AAPL)
  const bareParenPattern = /\(([A-Z]{1,5})\)/g;
  while ((match = bareParenPattern.exec(text)) !== null) {
    if (TICKER_TO_COMPANY[match[1]]) found.add(match[1]);
  }

  // Pattern 3: standalone all-caps word matching a known ticker
  const wordPattern = /\b([A-Z]{1,5})\b/g;
  while ((match = wordPattern.exec(text)) !== null) {
    if (TICKER_TO_COMPANY[match[1]]) found.add(match[1]);
  }

  return Array.from(found);
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Removes duplicate articles based on normalised headline text.
 * @param {Article[]} articles
 * @returns {Article[]}
 */
function deduplicateArticles(articles) {
  const seen = new Set();
  return articles.filter(article => {
    const key = article.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
