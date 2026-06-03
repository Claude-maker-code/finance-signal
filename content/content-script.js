// Injected on every Yahoo Finance page.
// Extracts articles from the live DOM (DOMParser not needed — direct querySelectorAll).
// Always merges structured-selector results with a full /news/ link harvest so
// no article section is missed regardless of page layout.

// ─── Config ──────────────────────────────────────────────────────────────────

const RETRY_DELAY_MS = 1200;
const MAX_RETRIES    = 6;    // up to ~7 seconds waiting for React to render
const MIN_NEWS_LINKS = 5;    // consider page ready when this many /news/ links exist

// ─── Entry points ─────────────────────────────────────────────────────────────

function reportArticles() {
  const articles = extractAllArticles();
  if (articles.length === 0) return;
  chrome.runtime.sendMessage({ type: "ARTICLES_REPORT", articles }).catch(() => {});
}

function waitForContentThenReport(retriesLeft) {
  const count = document.querySelectorAll('a[href*="/news/"]').length;
  if (count >= MIN_NEWS_LINKS || retriesLeft === 0) {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_ARTICLES") {
    sendResponse({ articles: extractAllArticles() });
  }
  return false;
});

// ─── Master extraction ────────────────────────────────────────────────────────

/**
 * Runs BOTH the structured-selector path and the /news/-link-harvest path,
 * then merges results so articles from every section of the page are included.
 * @returns {Article[]}
 */
function extractAllArticles() {
  const articles = [];
  const seenHeadlines = new Set();

  function addIfNew(article) {
    const key = article.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 15 || seenHeadlines.has(key)) return;
    seenHeadlines.add(key);
    articles.push(article);
  }

  // ── Structured path ──────────────────────────────────────────────────────
  // Good on topic/stream pages; may find sidebar articles on the homepage.
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
      extracted.forEach(addIfNew);
      break; // Only use first matching structured selector
    }
  }

  // ── Link-harvest path ────────────────────────────────────────────────────
  // Always runs — catches main article feed, related articles, sections missed
  // by structural selectors, and the full homepage article list.
  extractFromNewsLinks().forEach(addIfNew);

  return articles;
}

// ─── Structured element extraction ───────────────────────────────────────────

/**
 * @param {Element} el - A container element (li, div, article)
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
  if (isNavText(headline)) return null;

  const href      = linkEl ? linkEl.getAttribute("href") : "";
  const sourceUrl = normalizeUrl(href);
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
    source:       extractSourceName(el),
    quoteTickers: extractQuoteTickers(el)   // Yahoo Finance's own ticker tags
  };
}

// ─── Link-harvest extraction ──────────────────────────────────────────────────

/**
 * Harvests all /news/ anchor tags from the entire page.
 * For each anchor it tries to extract a clean headline (avoiding source/time
 * metadata that may be bundled inside the same anchor element).
 * @returns {Article[]}
 */
function extractFromNewsLinks() {
  const articles = [];

  for (const anchor of document.querySelectorAll('a[href*="/news/"]')) {
    const headline = cleanAnchorHeadline(anchor);
    if (!headline || headline.length < 15) continue;
    if (isNavText(headline)) continue;

    const container = findArticleContainer(anchor);
    articles.push({
      headline,
      summary:      "",
      publishedAt:  extractNearbyTimestamp(container || anchor),
      sourceUrl:    normalizeUrl(anchor.getAttribute("href") || ""),
      source:       extractNearbySource(anchor),
      quoteTickers: extractQuoteTickers(container || anchor)
    });
  }

  return articles;
}

/**
 * Extracts a clean headline from an anchor element.
 * Yahoo Finance sometimes wraps an entire article card in one <a>, which means
 * textContent includes source names, timestamps, and badge labels.
 * Extraction priority:
 *   1. h3/h2/h1 child element
 *   2. aria-label attribute
 *   3. title attribute
 *   4. Full text with metadata prefixes stripped
 * @param {Element} anchor
 * @returns {string}
 */
function cleanAnchorHeadline(anchor) {
  // Priority 1: heading child
  const heading = anchor.querySelector("h3, h2, h1");
  if (heading) return heading.textContent.trim();

  // Priority 2: aria-label
  const aria = anchor.getAttribute("aria-label");
  if (aria && aria.length > 15) return aria.trim();

  // Priority 3: title attribute
  const title = anchor.getAttribute("title");
  if (title && title.length > 15) return title.trim();

  // Priority 4: strip known metadata patterns from full text
  // Pattern: "Category • time Real headline…"
  //          "Breaking News • yesterday Real headline…"
  //          "News • 2 days ago Real headline…"
  let text = anchor.textContent.trim();
  text = text.replace(
    /^[\w\s]+\s*[·•·]\s*(?:\d+\s*(?:s|m|h|d|min|hr|sec|minute|hour|day|week)s?\s*ago|yesterday|today|just now)\s*/i,
    ""
  ).trim();

  return text;
}

// ─── Ticker extraction from Yahoo Finance's own quote links ───────────────────

/**
 * Yahoo Finance renders tickers as links to /quote/TICKER/ next to each article.
 * These are the ground-truth tickers associated with the story — more reliable
 * than text-matching for headlines that don't spell out ticker symbols.
 * @param {Element} container
 * @returns {string[]}
 */
function extractQuoteTickers(container) {
  if (!container) return [];
  const tickers = new Set();
  for (const link of container.querySelectorAll('a[href*="/quote/"]')) {
    const m = (link.getAttribute("href") || "").match(/\/quote\/([A-Z0-9.^-]{1,10})\/?/i);
    if (m) {
      const ticker = m[1].toUpperCase();
      // Skip currency pairs and indexes that aren't tradable stocks
      if (!/^[A-Z]{1,5}$/.test(ticker)) continue;
      tickers.add(ticker);
    }
  }
  return [...tickers];
}

/**
 * Finds the nearest ancestor element that contains /quote/ links.
 * Used to associate ticker tags with the right article in the fallback path.
 * @param {Element} anchor
 * @returns {Element|null}
 */
function findArticleContainer(anchor) {
  let el = anchor.parentElement;
  for (let depth = 0; depth < 6; depth++) {
    if (!el) break;
    if (el.querySelectorAll('a[href*="/quote/"]').length > 0) return el;
    el = el.parentElement;
  }
  return anchor.parentElement;
}

// ─── Timestamp helpers ────────────────────────────────────────────────────────

function extractNearbyTimestamp(el) {
  let node = el;
  for (let depth = 0; depth < 5; depth++) {
    if (!node) break;
    const timeEl = node.querySelector ? node.querySelector("time[datetime]") : null;
    if (timeEl) {
      const ts = Date.parse(timeEl.getAttribute("datetime"));
      if (!isNaN(ts)) return ts;
    }
    const relative = parseRelativeTime(node.textContent || "");
    if (relative !== null) return relative;
    node = node.parentElement;
  }
  return Date.now();
}

function parseRelativeTime(text) {
  const m = text.match(
    /(\d+)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?r)?s?|d(?:ay)?s?|w(?:eek)?s?)\s*ago/i
  );
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  const unit   = m[2][0].toLowerCase();
  const msMap  = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  return Date.now() - amount * (msMap[unit] || 3600000);
}

// ─── Source helpers ───────────────────────────────────────────────────────────

function extractSourceName(el) {
  const src = el.querySelector("[class*='provider'], [class*='source'], [class*='publisher'], figcaption");
  return src ? src.textContent.trim() : "Yahoo Finance";
}

function extractNearbySource(anchor) {
  let el = anchor.parentElement;
  for (let depth = 0; depth < 4; depth++) {
    if (!el) break;
    const m = el.textContent.trim().match(/^([A-Za-z][^·•·\n]{1,28}?)\s*[·•·]/);
    if (m && m[1].length >= 2 && m[1].length <= 30) return m[1].trim();
    const src = el.querySelector("[class*='provider'], [class*='source']");
    if (src) return src.textContent.trim();
    el = el.parentElement;
  }
  return "Yahoo Finance";
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeUrl(href) {
  if (!href)                   return "";
  if (href.startsWith("http")) return href;
  if (href.startsWith("//"))   return "https:" + href;
  if (href.startsWith("/"))    return "https://finance.yahoo.com" + href;
  return href;
}

function isNavText(text) {
  return /^(sign in|log in|my portfolio|markets|news|finance|sports|more|videos|research|community|personal finance|watch now)$/i.test(text);
}

/**
 * @typedef {Object} Article
 * @property {string}   headline
 * @property {string}   summary
 * @property {number}   publishedAt
 * @property {string}   sourceUrl
 * @property {string}   source
 * @property {string[]} quoteTickers - tickers extracted from Yahoo Finance's /quote/ links
 */
