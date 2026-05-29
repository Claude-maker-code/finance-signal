import { STORAGE_KEYS } from "../shared/constants.js";
import { formatRelativeTime } from "../analysis/recency-filter.js";
import { saveFeedback, getFeedbackForSignal, getFeedbackForTicker } from "../feedback/feedback-store.js";

// ─── State ────────────────────────────────────────────────────────────────

let pendingFeedback = null; // { signalId, ticker, rating }

// ─── Bootstrap ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  initRefreshButton();
  initFeedbackModal();
  initStorageListener();
  loadAndRender();
});

// ─── Data loading ─────────────────────────────────────────────────────────

function loadAndRender() {
  chrome.storage.local.get(
    [STORAGE_KEYS.LATEST_SIGNALS, STORAGE_KEYS.LATEST_ARTICLES, STORAGE_KEYS.LAST_FETCH_TIME],
    async result => {
      const signals = result[STORAGE_KEYS.LATEST_SIGNALS] || null;
      const articles = result[STORAGE_KEYS.LATEST_ARTICLES] || null;
      const lastFetchTime = result[STORAGE_KEYS.LAST_FETCH_TIME] || null;

      updateLastUpdatedLabel(lastFetchTime);
      await renderSignals(signals);
      renderNewsFeed(articles);
    }
  );
}

// Re-render automatically when the background worker writes new data
function initStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEYS.LATEST_SIGNALS]) {
      loadAndRender();
      stopRefreshSpinner();
    }
  });
}

// ─── Signals panel ────────────────────────────────────────────────────────

async function renderSignals(signals) {
  const loadingEl  = document.getElementById("signals-loading");
  const emptyEl    = document.getElementById("signals-empty");
  const noTabEl    = document.getElementById("signals-no-tab");
  const listEl     = document.getElementById("signal-list");

  // Reset all states before rendering
  loadingEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  noTabEl.classList.add("hidden");
  listEl.innerHTML = "";

  if (signals === null) {
    // No data at all — ask the background to pull from an open Yahoo Finance tab.
    // The response tells us whether a tab was found.
    loadingEl.classList.remove("hidden");
    chrome.runtime.sendMessage({ type: "REQUEST_REFRESH" }, response => {
      loadingEl.classList.add("hidden");
      if (response?.reason === "no_yahoo_tab") {
        noTabEl.classList.remove("hidden");
      }
      // If success, the storage listener will call loadAndRender automatically.
    });
    return;
  }

  if (signals.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  // Batch-load all feedback for this render pass to avoid serial chrome.storage calls
  for (const signal of signals) {
    const [tickerFeedback, existingFeedback] = await Promise.all([
      getFeedbackForTicker(signal.ticker),
      getFeedbackForSignal(signal.signalId)
    ]);
    listEl.appendChild(buildSignalCard(signal, existingFeedback, tickerFeedback));
  }
}

/**
 * Builds a complete signal card DOM element.
 * @param {import("../analysis/signal-engine.js").Signal} signal
 * @param {import("../feedback/feedback-store.js").FeedbackEntry|null} existingFeedback
 * @param {import("../feedback/feedback-store.js").FeedbackEntry[]} tickerHistory
 * @returns {HTMLLIElement}
 */
function buildSignalCard(signal, existingFeedback, tickerHistory) {
  const confidenceTier = signal.confidence >= 70 ? "high" : signal.confidence >= 40 ? "medium" : "low";
  const actionClass = signal.action === "BUY" ? "buy" : "sell";

  const li = document.createElement("li");
  li.className = "signal-card";
  li.dataset.signalId = signal.signalId;

  // ── Header ──────────────────────────────────────────────────────────────
  const header = createElement("div", "signal-card-header");

  const leftCol = createElement("div", "signal-left");
  const tickerRow = createElement("div", "signal-ticker-row");
  tickerRow.append(
    createElement("span", "signal-ticker", signal.ticker),
    createElement("span", `signal-action-badge ${actionClass}`, signal.action)
  );
  leftCol.append(tickerRow, createElement("div", "signal-company", signal.companyDescription));

  const barFill = createElement("div", `confidence-bar-fill ${confidenceTier}`);
  barFill.style.width = `${signal.confidence}%`;
  const barTrack = createElement("div", "confidence-bar-track");
  barTrack.appendChild(barFill);

  const confidenceBlock = createElement("div", "signal-confidence-block");
  confidenceBlock.append(
    createElement("span", "confidence-label", "Confidence"),
    createElement("span", `confidence-value ${confidenceTier}`, `${signal.confidence}%`),
    barTrack
  );

  header.append(leftCol, confidenceBlock);
  li.appendChild(header);

  // ── Previous ticker feedback notice ──────────────────────────────────────
  // Show aggregated feedback history for this ticker from prior signals
  const priorFeedback = tickerHistory.filter(f => f.signalId !== signal.signalId);
  if (priorFeedback.length > 0) {
    const upCount = priorFeedback.filter(f => f.rating === "up").length;
    const downCount = priorFeedback.filter(f => f.rating === "down").length;
    const lastEntry = priorFeedback[priorFeedback.length - 1];

    const historyEl = document.createElement("div");
    historyEl.className = "ticker-feedback-history";
    historyEl.innerHTML =
      `Your history on <strong>${escapeHtml(signal.ticker)}</strong>: ${upCount} 👍 / ${downCount} 👎` +
      (lastEntry.note ? ` — "<em>${escapeHtml(lastEntry.note)}</em>"` : "");
    li.appendChild(historyEl);
  }

  // ── Reason ──────────────────────────────────────────────────────────────
  li.appendChild(createElement("p", "signal-reason", signal.reason));

  // ── Supporting articles accordion ────────────────────────────────────────
  const articleCount = signal.supportingArticles.length;
  const toggleBtn = createElement(
    "button",
    "signal-articles-toggle",
    `${articleCount} supporting article${articleCount !== 1 ? "s" : ""}`
  );
  toggleBtn.appendChild(createElement("span", "toggle-chevron", "▾"));

  const articlesList = createElement("div", "signal-articles-list");
  for (const article of signal.supportingArticles) {
    articlesList.appendChild(buildArticleItem(article));
  }

  toggleBtn.addEventListener("click", () => {
    const isOpen = articlesList.classList.toggle("open");
    toggleBtn.classList.toggle("open", isOpen);
  });

  li.append(toggleBtn, articlesList);

  // ── Feedback row ─────────────────────────────────────────────────────────
  li.appendChild(buildFeedbackRow(signal, existingFeedback));

  return li;
}

/**
 * Builds one article row inside the accordion.
 * @param {import("../analysis/signal-engine.js").SupportingArticle} article
 * @returns {HTMLDivElement}
 */
function buildArticleItem(article) {
  const item = createElement("div", "article-item");

  const link = document.createElement("a");
  link.className = "article-headline";
  link.textContent = article.headline;
  link.href = article.sourceUrl || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  const meta = createElement("div", "article-meta");
  meta.textContent = formatRelativeTime(article.publishedAt);
  if (article.source) {
    meta.textContent += ` · ${article.source}`;
  }

  item.append(link, meta);

  if (article.matchedKeywords && article.matchedKeywords.length > 0) {
    item.appendChild(createElement(
      "span",
      "article-keywords",
      `Matched: ${article.matchedKeywords.slice(0, 4).join(", ")}`
    ));
  }

  return item;
}

/**
 * Builds the thumbs-up/down feedback row for a signal card.
 * Always attaches click handlers so the user can update existing feedback.
 * @param {import("../analysis/signal-engine.js").Signal} signal
 * @param {import("../feedback/feedback-store.js").FeedbackEntry|null} existingFeedback
 * @returns {HTMLDivElement}
 */
function buildFeedbackRow(signal, existingFeedback) {
  const row = createElement("div", "signal-feedback");
  const upBtn = createElement("button", "feedback-thumb-btn", "👍");
  const downBtn = createElement("button", "feedback-thumb-btn", "👎");
  upBtn.title = "Good signal — click to rate";
  downBtn.title = "Poor signal — click to rate";

  if (existingFeedback) {
    applyFeedbackSelection(upBtn, downBtn, existingFeedback.rating);
  }

  // Always attach handlers — users can update or add notes at any time
  upBtn.addEventListener("click", () => openFeedbackModal(signal, "up", upBtn, downBtn));
  downBtn.addEventListener("click", () => openFeedbackModal(signal, "down", upBtn, downBtn));

  row.append(createElement("span", "feedback-label", "Was this useful?"), upBtn, downBtn);

  if (existingFeedback && existingFeedback.note) {
    row.appendChild(createElement("span", "feedback-existing-note", `"${existingFeedback.note}"`));
  }

  return row;
}

function applyFeedbackSelection(upBtn, downBtn, rating) {
  upBtn.classList.remove("selected-up");
  downBtn.classList.remove("selected-down");
  if (rating === "up") {
    upBtn.classList.add("selected-up");
  } else {
    downBtn.classList.add("selected-down");
  }
}

// ─── News feed panel ──────────────────────────────────────────────────────

function renderNewsFeed(articles) {
  const loadingEl = document.getElementById("news-loading");
  const emptyEl = document.getElementById("news-empty");
  const listEl = document.getElementById("news-list");

  loadingEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  listEl.innerHTML = "";

  if (!articles || articles.length === 0) {
    emptyEl.classList.remove("hidden");
    return;
  }

  const sorted = [...articles].sort((a, b) => b.publishedAt - a.publishedAt);

  for (const article of sorted) {
    const li = createElement("li", "news-item");

    const link = document.createElement("a");
    link.className = "news-headline";
    link.textContent = article.headline;
    link.href = article.sourceUrl || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const meta = createElement("div", "news-meta");
    meta.textContent = formatRelativeTime(article.publishedAt);
    if (article.source) {
      meta.textContent += ` · ${article.source}`;
    }

    li.append(link, meta);

    if (article.tickers && article.tickers.length > 0) {
      const tickersRow = createElement("div", "news-tickers");
      for (const ticker of article.tickers) {
        tickersRow.appendChild(createElement("span", "ticker-badge", ticker));
      }
      li.appendChild(tickersRow);
    }

    listEl.appendChild(li);
  }
}

// ─── Feedback modal ───────────────────────────────────────────────────────

function initFeedbackModal() {
  document.getElementById("feedback-close").addEventListener("click", closeFeedbackModal);
  document.getElementById("feedback-submit").addEventListener("click", submitFeedback);
  document.getElementById("feedback-overlay").addEventListener("click", event => {
    if (event.target === event.currentTarget) {
      closeFeedbackModal();
    }
  });
}

function openFeedbackModal(signal, rating, upBtn, downBtn) {
  pendingFeedback = { signalId: signal.signalId, ticker: signal.ticker, rating, upBtn, downBtn };

  document.getElementById("feedback-modal-title").textContent =
    `${rating === "up" ? "👍" : "👎"} ${signal.ticker} — ${signal.action} signal`;
  document.getElementById("feedback-note").value = "";
  document.getElementById("feedback-overlay").classList.remove("hidden");
  document.getElementById("feedback-note").focus();
}

function closeFeedbackModal() {
  pendingFeedback = null;
  document.getElementById("feedback-overlay").classList.add("hidden");
  document.getElementById("feedback-note").value = "";
}

async function submitFeedback() {
  if (!pendingFeedback) {
    return;
  }

  const note = document.getElementById("feedback-note").value.trim();
  const { signalId, ticker, rating, upBtn, downBtn } = pendingFeedback;

  await saveFeedback({ signalId, ticker, rating, note, recordedAt: Date.now() });

  applyFeedbackSelection(upBtn, downBtn, rating);

  const feedbackRow = upBtn.closest(".signal-feedback");
  if (feedbackRow) {
    const existingNote = feedbackRow.querySelector(".feedback-existing-note");
    if (note) {
      if (existingNote) {
        existingNote.textContent = `"${note}"`;
      } else {
        feedbackRow.appendChild(createElement("span", "feedback-existing-note", `"${note}"`));
      }
    } else if (existingNote) {
      existingNote.remove();
    }
  }

  closeFeedbackModal();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────

function initTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.id === `tab-${targetTab}`);
        panel.classList.toggle("hidden", panel.id !== `tab-${targetTab}`);
      });
    });
  });
}

// ─── Refresh button ───────────────────────────────────────────────────────

function initRefreshButton() {
  const btn = document.getElementById("refresh-btn");
  btn.addEventListener("click", () => {
    btn.classList.add("spinning");
    btn.disabled = true;

    chrome.runtime.sendMessage({ type: "REQUEST_REFRESH" }, response => {
      if (response?.reason === "no_yahoo_tab") {
        stopRefreshSpinner();
        // Show the no-tab guidance state in the signals panel
        document.getElementById("signals-loading").classList.add("hidden");
        document.getElementById("signals-empty").classList.add("hidden");
        document.getElementById("signal-list").innerHTML = "";
        document.getElementById("signals-no-tab").classList.remove("hidden");
      }
      // On success the storage listener fires and re-renders; timeout is a fallback only.
    });

    setTimeout(stopRefreshSpinner, 15000);
  });
}

function stopRefreshSpinner() {
  const btn = document.getElementById("refresh-btn");
  btn.classList.remove("spinning");
  btn.disabled = false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function updateLastUpdatedLabel(lastFetchTime) {
  const el = document.getElementById("last-updated");
  el.textContent = lastFetchTime
    ? `Updated ${formatRelativeTime(lastFetchTime)}`
    : "Never updated";
}

/**
 * Creates a DOM element with a className and optional text content.
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function createElement(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
