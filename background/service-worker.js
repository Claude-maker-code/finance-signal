import { parseNewsPage } from "../analysis/news-parser.js";
import { filterToRecentArticles } from "../analysis/recency-filter.js";
import { generateSignals } from "../analysis/signal-engine.js";
import {
  STORAGE_KEYS,
  REFRESH_ALARM_NAME,
  REFRESH_INTERVAL_MINUTES
} from "../shared/constants.js";

// How old stored data can be before we mark it stale (2 hours in ms)
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  checkStaleness();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === REFRESH_ALARM_NAME) {
    checkStaleness();
  }
});

// ─── Message handlers ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Content script pushes the Yahoo Finance page HTML on every page load.
  // This is the primary data ingestion path — fully user-initiated.
  if (message.type === "PAGE_HTML_REPORT") {
    analyzeAndStore(message.html).catch(err =>
      console.error("[FinanceSignal] Analysis failed:", err)
    );
    return false;
  }

  // Popup requests a manual refresh. Find an open Yahoo Finance tab and ask
  // its content script for the current HTML.
  if (message.type === "REQUEST_REFRESH") {
    requestHtmlFromOpenTab()
      .then(html => {
        if (!html) {
          sendResponse({ success: false, reason: "no_yahoo_tab" });
          return;
        }
        return analyzeAndStore(html).then(() =>
          sendResponse({ success: true })
        );
      })
      .catch(err => {
        console.error("[FinanceSignal] Refresh failed:", err);
        sendResponse({ success: false, reason: "error" });
      });
    return true; // Keep message channel open for async response
  }

  return false;
});

// ─── Core logic ──────────────────────────────────────────────────────────────

/**
 * Parses and analyzes HTML from the Yahoo Finance page, then persists results.
 * @param {string} html
 * @returns {Promise<void>}
 */
async function analyzeAndStore(html) {
  const allArticles = parseNewsPage(html);
  const recentArticles = filterToRecentArticles(allArticles);
  const signals = generateSignals(recentArticles);

  await storeResults(recentArticles, signals);
  updateBadge(signals.length, false);
}

/**
 * Finds an open Yahoo Finance tab and asks its content script for the page HTML.
 * Uses host_permissions (no tabs permission needed) to query by URL.
 * Returns null if no matching tab is open or the content script does not respond.
 * @returns {Promise<string|null>}
 */
async function requestHtmlFromOpenTab() {
  const tabs = await chrome.tabs.query({ url: "https://finance.yahoo.com/*" });
  if (tabs.length === 0) {
    return null;
  }

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabs[0].id, { type: "GET_PAGE_HTML" }, response => {
      if (chrome.runtime.lastError || !response?.html) {
        resolve(null);
      } else {
        resolve(response.html);
      }
    });
  });
}

/**
 * Checks whether stored data is stale and updates the badge accordingly.
 * Does not fetch or request new data — that is triggered only by user navigation.
 * @returns {Promise<void>}
 */
async function checkStaleness() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.LAST_FETCH_TIME,
    STORAGE_KEYS.LATEST_SIGNALS
  ]);

  const lastFetch = result[STORAGE_KEYS.LAST_FETCH_TIME] || 0;
  const signals = result[STORAGE_KEYS.LATEST_SIGNALS] || [];
  const isStale = Date.now() - lastFetch > STALE_THRESHOLD_MS;

  if (isStale) {
    // Clear the signal count badge — data is too old to be actionable
    updateBadge(0, false);
  } else {
    updateBadge(signals.length, false);
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/**
 * @param {import("../analysis/news-parser.js").Article[]} articles
 * @param {import("../analysis/signal-engine.js").Signal[]} signals
 * @returns {Promise<void>}
 */
function storeResults(articles, signals) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEYS.LATEST_SIGNALS]: signals,
        [STORAGE_KEYS.LATEST_ARTICLES]: articles,
        [STORAGE_KEYS.LAST_FETCH_TIME]: Date.now()
      },
      () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      }
    );
  });
}

// ─── Badge ───────────────────────────────────────────────────────────────────

/**
 * @param {number} count
 * @param {boolean} [isError]
 */
function updateBadge(count, isError = false) {
  if (isError) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#cc3333" });
    return;
  }
  if (count === 0) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  chrome.action.setBadgeText({ text: String(count) });
  chrome.action.setBadgeBackgroundColor({ color: "#1a7a4a" });
}

// ─── Alarm ───────────────────────────────────────────────────────────────────

function scheduleAlarm() {
  chrome.alarms.create(REFRESH_ALARM_NAME, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });
}
