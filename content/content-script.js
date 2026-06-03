// Injected on every Yahoo Finance page the user navigates to.
// All DOM parsing happens here — content scripts have full page-context access
// including DOMParser, querySelectorAll, etc. The service worker does not.
//
// Extracts article data from the live DOM and sends it as a structured array;
// the service worker only needs to run pure-JS sentiment analysis on the result.

// ─── Config ──────────────────────────────────────────────────────────────────

const RETRY_DELAY_MS = 1200; // ms between readiness retries
const MAX_RETRIES    = 6;    // ~7 seconds total wait time
const MIN_NEWS_LINKS = 5;    // page is considered ready when this many /news/ links exist

// ─── Entry points ─────────────────────────────────────────────────────────────

function reportArticles() {
  const articles = extractArticles();
  if (articles.length === 0) return; // Nothing to report yet
  chrome.runtime.sendMessage({ type: "ARTICLES_REPORT", articles }).catch(() => {
    // Service worker may be inactive on a cold extension start — safe to ignore.
  });
}

/**
 * Waits until Yahoo Finance's React app has rendered article links,
 * then extracts and reports. Falls back after MAX_RETRIES attempts.
 * @param {number} retriesLeft
 */
function waitForContentThenReport(retriesLeft) {
  const newsLinkCount = document.querySelectorAll('a[href*="/news/"]').length;
  if (newsLinkCount >= MIN_NEWS_LINKS || retriesLeft === 0) {
    reportArticles();
  } else {
    setTimeout(() => waitForContentThenReport(retriesLeft - 1), RETRY_DELAY_MS);
  }
}

if (document.readyState === "complete") {
  waitForContentThenReport(MAX_RETRIES);
} else {
  window.addEventListener("load", () => waitForContentThenReport(MAX_RETRIES), { once: true });
}

// Respond to on-demand refresh requests from the service worker
// (triggered when the user clicks the refresh button in the popup).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_ARTICLES") {
    sendResponse({ articles: extractArticles() });
  }
  return false;
});

// ─── Article extraction ───────────────────────────────────────────────────────

/**
 * Extracts news articles from the current Yahoo Finance page.
 * Tries structured CSS selectors first; falls back to harvesting all /news/ links.
 * @returns {Article[]}
 */
function extractArticles() {
  // Selectors ordered from most specific (topic/stream pages) to most generic.
  // A selector is accepted only if it yields ≥ 2 valid articles — prevents a
  // single mis-matched element (e.g. a featured article on the homepage) from
  // blocking the fallback path.
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
    const elements = Array.from(document.querySelectorAll(selector));
    if (elements.length < 2) continue;

    const extracted = elements.map(extractFromElement).filter(Boolean);
    if (extracted.length >= 2) {
      return deduplicate(extracted);
    }
  }

  // Fallback: works on any Yahoo Finance page layout (homepage, section pages, etc.)
  return extractFromNewsLinks();
}

/**
 * Extracts a single article from a structured container element.
 * @param {Element} el
 * @returns {Article|null}
 */
function extractFromElement(el) {
  const headlineEl = el.querySelector(
    "h3, h2, h1, [class*='headline'], [class*='title'], a[class*='title']"
  );
  const linkEl = el.querySelector("a[href]");

  if (!headlineEl && !linkEl) return null;

  const headline = (headlineEl || linkEl).textContent.trim();
  if (!headline || headline.length < 10) return null;

  // Filter out navigation / UI elements that match broad selectors
  if (/^(sign in|log in|my portfolio|markets|news|finance|sports|more)$/i.test(headline)) {
    return null;
  }

  const href       = linkEl ? linkEl.getAttribute("href") : "";
  const sourceUrl  = normalizeUrl(href);

  // Only keep links pointing at actual articles
  if (sourceUrl && !sourceUrl.includes("/news/") && !sourceUrl.includes("finance.yahoo.com")) {
    return null;
  }

  const summaryEl  = el.querySelector("p, [class*='summary'], [class*='description'], [class*='excerpt']");
  const summary    = summaryEl ? summaryEl.textContent.trim() : "";
  const timeEl     = el.querySelector("time[datetime]");
  const publishedAt = timeEl
    ? (Date.parse(timeEl.getAttribute("datetime")) || extractNearbyTimestamp(el))
    : extractNearbyTimestamp(el);

  return {
    headline,
    summary,
    publishedAt,
    sourceUrl,
    source: extractSourceName(el)
  };
}

/**
 * Fallback: harvests all anchor tags whose href contains "/news/".
 * Works reliably on any Yahoo Finance page layout.
 * @returns {Article[]}
 */
function extractFromNewsLinks() {
  const articles = [];

  for (const anchor of document.querySelectorAll('a[href*="/news/"]')) {
    const text = anchor.textContent.trim();
    if (text.length < 15) continue;
    if (/^(news|latest|trending|all)$/i.test(text)) continue;

    articles.push({
      headline:     text,
      summary:      "",
      publishedAt:  extractNearbyTimestamp(anchor),
      sourceUrl:    normalizeUrl(anchor.getAttribute("href") || ""),
      source:       extractNearbySource(anchor)
    });
  }

  return deduplicate(articles);
}

// ─── Timestamp helpers ────────────────────────────────────────────────────────

/**
 * Walks up to 5 ancestor elements looking for a timestamp.
 * Handles ISO datetime attributes and relative strings like "6m ago" / "4h ago".
 * @param {Element} el
 * @returns {number} Unix timestamp in milliseconds
 */
function extractNearbyTimestamp(el) {
  let node = el;
  for (let depth = 0; depth < 5; depth++) {
    if (!node) break;

    // <time datetime="ISO string">
    const timeEl = node.querySelector ? node.querySelector("time[datetime]") : null;
    if (timeEl) {
      const ts = Date.parse(timeEl.getAttribute("datetime"));
      if (!isNaN(ts)) return ts;
    }

    // Relative text: "6m ago", "4h ago", "2d ago", "6 minutes ago", etc.
    const relative = parseRelativeTime(node.textContent || "");
    if (relative !== null) return relative;

    node = node.parentElement;
  }
  return Date.now();
}

/**
 * Parses a relative time string into a Unix timestamp.
 * @param {string} text
 * @returns {number|null}
 */
function parseRelativeTime(text) {
  const match = text.match(
    /(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?r)?s?|d(?:ay)?s?)\s*ago/i
  );
  if (!match) return null;
  const amount   = parseInt(match[1], 10);
  const unitChar = match[2][0].toLowerCase();
  const msMap    = { m: 60000, h: 3600000, d: 86400000 };
  return Date.now() - amount * (msMap[unitChar] || 3600000);
}

// ─── Source helpers ───────────────────────────────────────────────────────────

/**
 * Extracts a publisher name from a structured article element.
 * @param {Element} el
 * @returns {string}
 */
function extractSourceName(el) {
  const src = el.querySelector("[class*='provider'], [class*='source'], [class*='publisher'], figcaption");
  return src ? src.textContent.trim() : "Yahoo Finance";
}

/**
 * Walks nearby elements to find a publisher name adjacent to a link.
 * Handles patterns like "Reuters · 6m ago".
 * @param {Element} anchor
 * @returns {string}
 */
function extractNearbySource(anchor) {
  let el = anchor.parentElement;
  for (let depth = 0; depth < 4; depth++) {
    if (!el) break;
    const match = el.textContent.trim().match(/^([A-Za-z][^·•·\n]{1,28}?)\s*[·•·]/);
    if (match && match[1].length >= 2 && match[1].length <= 30) return match[1].trim();
    const src = el.querySelector("[class*='provider'], [class*='source']");
    if (src) return src.textContent.trim();
    el = el.parentElement;
  }
  return "Yahoo Finance";
}

// ─── URL helper ───────────────────────────────────────────────────────────────

/**
 * @param {string} href
 * @returns {string}
 */
function normalizeUrl(href) {
  if (!href)                  return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//"))   return "https:" + href;
  if (href.startsWith("/"))    return "https://finance.yahoo.com" + href;
  return href;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * @param {Article[]} articles
 * @returns {Article[]}
 */
function deduplicate(articles) {
  const seen = new Set();
  return articles.filter(a => {
    const key = a.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @typedef {Object} Article
 * @property {string} headline
 * @property {string} summary
 * @property {number} publishedAt
 * @property {string} sourceUrl
 * @property {string} source
 */
