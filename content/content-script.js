// Injected on every Yahoo Finance page.
// Extracts articles from the live DOM (no DOMParser — direct querySelectorAll).
//
// Key design principles:
//  • BOTH the structured-selector path and the /news/ link-harvest path always run.
//  • Results are merged using a Map keyed by normalised headline — if the same
//    article appears in both passes, their quoteTickers arrays are MERGED so
//    that tickers found in either pass are preserved.
//  • "quoteTickers" are Yahoo Finance's own /quote/TICKER/ links rendered next
//    to each article. These are passed to the service worker so articles like
//    "Alphabet's $80B stock sale" can produce a GOOGL signal even though the
//    headline text doesn't contain "GOOGL".

// ─── Config ──────────────────────────────────────────────────────────────────

const RETRY_DELAY_MS     = 1200;
const MAX_RETRIES        = 8;     // up to ~10 seconds waiting for React to render
const MIN_READY_ARTICLES = 3;     // page is ready when this many articles WITH ticker tags exist

// ─── Entry points ─────────────────────────────────────────────────────────────

function reportArticles() {
  const articles = extractAllArticles();
  if (articles.length === 0) return;
  chrome.runtime.sendMessage({ type: "ARTICLES_REPORT", articles }).catch(() => {});
}

/**
 * Waits until React has rendered article cards WITH associated ticker tags,
 * then reports. Falls back after MAX_RETRIES whether or not tickers are found.
 */
function waitForContentThenReport(retriesLeft) {
  if (countArticlesWithTickers() >= MIN_READY_ARTICLES || retriesLeft === 0) {
    reportArticles();
  } else {
    setTimeout(() => waitForContentThenReport(retriesLeft - 1), RETRY_DELAY_MS);
  }
}

/**
 * Counts how many /news/ anchors have a /quote/ link in a nearby container.
 * Used as the readiness signal so we don't report before tickers have rendered.
 */
function countArticlesWithTickers() {
  let count = 0;
  for (const anchor of document.querySelectorAll('a[href*="/news/"]')) {
    if (count >= MIN_READY_ARTICLES) break;
    if (findContainerWithTickers(anchor)) count++;
  }
  return count;
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
 * Runs both extraction paths and merges into a single deduplicated list.
 * Uses a Map so that if the same article is found in both passes, the quoteTickers
 * from both passes are UNIONED — this handles the common case where a structured
 * selector captures the headline element but not the sibling ticker element.
 * @returns {Article[]}
 */
function extractAllArticles() {
  // Map: normalised headline → article object (allows enrichment on duplicate)
  const articleMap = new Map();

  function addOrEnrich(article) {
    const key = article.headline.toLowerCase().replace(/\s+/g, " ").trim();
    if (key.length < 15) return;

    if (!articleMap.has(key)) {
      articleMap.set(key, { ...article, quoteTickers: [...(article.quoteTickers || [])] });
    } else {
      // Same article seen again — enrich with any new tickers found in this pass
      const existing = articleMap.get(key);
      const merged   = [...new Set([...existing.quoteTickers, ...(article.quoteTickers || [])])];
      articleMap.set(key, { ...existing, quoteTickers: merged });
    }
  }

  // ── Structured path (good on topic/stream pages; may miss tickers on homepage) ──
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
      extracted.forEach(addOrEnrich);
      break;
    }
  }

  // ── Link-harvest path (always runs, covers all page layouts) ──────────────
  extractFromNewsLinks().forEach(addOrEnrich);

  return [...articleMap.values()];
}

// ─── Structured element extraction ───────────────────────────────────────────

/**
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
  if (!headline || headline.length < 10 || isNavText(headline)) return null;

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

  // Walk UP from el to find the container that actually holds the ticker links —
  // structured selectors often match a sub-element that does not contain siblings
  const tickerContainer = findContainerWithTickers(el) || el;

  return {
    headline,
    summary,
    publishedAt,
    sourceUrl,
    source:       extractSourceName(el),
    quoteTickers: extractQuoteTickers(tickerContainer)
  };
}

// ─── Link-harvest extraction ──────────────────────────────────────────────────

/**
 * Harvests every /news/ anchor tag from the full page DOM.
 * For each anchor, walks up the DOM to find a container that includes the
 * article's associated /quote/ ticker links.
 * @returns {Article[]}
 */
function extractFromNewsLinks() {
  const articles = [];

  for (const anchor of document.querySelectorAll('a[href*="/news/"]')) {
    const headline = cleanAnchorHeadline(anchor);
    if (!headline || headline.length < 15 || isNavText(headline)) continue;

    const container = findContainerWithTickers(anchor) || anchor.parentElement;

    articles.push({
      headline,
      summary:      "",
      publishedAt:  extractNearbyTimestamp(container || anchor),
      sourceUrl:    normalizeUrl(anchor.getAttribute("href") || ""),
      source:       extractNearbySource(anchor),
      quoteTickers: extractQuoteTickers(container)
    });
  }

  return articles;
}

/**
 * Extracts a clean headline from an anchor, stripping metadata prefixes.
 * Priority: h3/h2/h1 child → aria-label → title attr → stripped text content.
 */
function cleanAnchorHeadline(anchor) {
  const heading = anchor.querySelector("h3, h2, h1");
  if (heading) return heading.textContent.trim();

  const aria = anchor.getAttribute("aria-label");
  if (aria && aria.length > 15) return aria.trim();

  const title = anchor.getAttribute("title");
  if (title && title.length > 15) return title.trim();

  // Strip "Category · time" prefixes like "Breaking News • yesterday "
  let text = anchor.textContent.trim();
  text = text.replace(
    /^[\w\s]+\s*[·•·]\s*(?:\d+\s*(?:s|m|h|d|min|hr|sec|minute|hour|day|week)s?\s*ago|yesterday|today|just now)\s*/i,
    ""
  ).trim();

  return text;
}

// ─── Ticker container helpers ─────────────────────────────────────────────────

/**
 * Walks UP the DOM from el to find the nearest ancestor that:
 *   • contains at least one /quote/ link  AND
 *   • contains no more than 3 /news/ links (avoids capturing an entire section)
 *
 * The "≤3 news links" guard prevents overshoot into a parent that spans multiple
 * articles and would incorrectly assign ALL section tickers to one article.
 *
 * @param {Element} el
 * @returns {Element|null}
 */
function findContainerWithTickers(el) {
  let node = el.parentElement || el;
  for (let depth = 0; depth < 7; depth++) {
    if (!node) break;
    const quoteCount = node.querySelectorAll('a[href*="/quote/"]').length;
    const newsCount  = node.querySelectorAll('a[href*="/news/"]').length;
    if (quoteCount > 0 && newsCount <= 3) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Extracts all ticker symbols from /quote/TICKER/ links in the given container.
 * Filters to simple stock tickers (1–5 uppercase letters) to exclude currency
 * pairs (JPY=X), futures (CL=F), and other non-stock instruments.
 * @param {Element|null} container
 * @returns {string[]}
 */
function extractQuoteTickers(container) {
  if (!container) return [];
  const tickers = new Set();
  for (const link of container.querySelectorAll('a[href*="/quote/"]')) {
    const m = (link.getAttribute("href") || "").match(/\/quote\/([A-Z0-9.^=-]{1,10})\/?/i);
    if (!m) continue;
    const ticker = m[1].toUpperCase();
    if (/^[A-Z]{1,5}$/.test(ticker)) tickers.add(ticker); // stocks only, no special chars
  }
  return [...tickers];
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
  return Date.now() - amount * ({ s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[unit] || 3600000);
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
 * @property {string[]} quoteTickers
 */
