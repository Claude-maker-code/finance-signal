// Service worker: receives pre-parsed articles from the content script,
// annotates them with ticker symbols, runs sentiment analysis, and stores results.
//
// DOMParser is NOT available in service workers — all HTML/DOM parsing is
// done in content-script.js which runs in the full page context.

import { extractTickersFromText } from "../analysis/news-parser.js";
import { filterToRecentArticles }  from "../analysis/recency-filter.js";
import { generateSignals }         from "../analysis/signal-engine.js";
import {
  STORAGE_KEYS,
  REFRESH_ALARM_NAME,
  REFRESH_INTERVAL_MINUTES,
  TICKER_TO_COMPANY
} from "../shared/constants.js";

const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

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

// ─── Message handlers ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // Content script pushes articles whenever the user visits a Yahoo Finance page.
  if (message.type === "ARTICLES_REPORT") {
    if (Array.isArray(message.articles) && message.articles.length > 0) {
      analyzeAndStore(message.articles).catch(err =>
        console.error("[FinanceSignal] Analysis failed:", err)
      );
    }
    return false;
  }

  // Popup requests a manual refresh — find an open Yahoo Finance tab and ask
  // its content script for the current articles.
  if (message.type === "REQUEST_REFRESH") {
    requestArticlesFromOpenTab()
      .then(articles => {
        if (!articles || articles.length === 0) {
          sendResponse({ success: false, reason: "no_yahoo_tab" });
          return;
        }
        return analyzeAndStore(articles).then(() =>
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

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Annotates articles with ticker symbols, applies the 72-hour recency filter,
 * generates signals, and persists everything to storage.
 *
 * @param {import("../content/content-script.js").Article[]} rawArticles
 * @returns {Promise<void>}
 */
async function analyzeAndStore(rawArticles) {
  // Build final ticker list for each article by merging two sources:
  //   1. quoteTickers — tickers Yahoo Finance explicitly tagged on the article (most reliable)
  //   2. extractTickersFromText — tickers found by scanning the headline/summary text
  // Both are filtered to only known tickers so unknown symbols don't create noise.
  const articles = rawArticles.map(article => {
    const fromYahoo = (article.quoteTickers || []).filter(t => TICKER_TO_COMPANY[t]);
    const fromText  = extractTickersFromText(article.headline + " " + (article.summary || ""));
    const merged    = [...new Set([...fromYahoo, ...fromText])];
    return { ...article, tickers: merged };
  });

  const recentArticles = filterToRecentArticles(articles);
  const signals        = generateSignals(recentArticles);

  await storeResults(recentArticles, signals);
  updateBadge(signals.length);
}

/**
 * Finds an open Yahoo Finance tab and asks its content script for articles.
 * Uses host_permissions to query by URL — no `tabs` permission needed.
 * Returns null if no matching tab is open or content script does not respond.
 *
 * @returns {Promise<Article[]|null>}
 */
async function requestArticlesFromOpenTab() {
  const tabs = await chrome.tabs.query({ url: "https://finance.yahoo.com/*" });
  if (tabs.length === 0) return null;

  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabs[0].id, { type: "GET_ARTICLES" }, response => {
      if (chrome.runtime.lastError || !response?.articles?.length) {
        resolve(null);
      } else {
        resolve(response.articles);
      }
    });
  });
}

/**
 * Checks whether stored data is stale and updates the badge.
 * Does not fetch new data — that is triggered only by user navigation.
 */
async function checkStaleness() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.LAST_FETCH_TIME,
    STORAGE_KEYS.LATEST_SIGNALS
  ]);

  const lastFetch = result[STORAGE_KEYS.LAST_FETCH_TIME] || 0;
  const signals   = result[STORAGE_KEYS.LATEST_SIGNALS]  || [];
  const isStale   = Date.now() - lastFetch > STALE_THRESHOLD_MS;

  updateBadge(isStale ? 0 : signals.length);
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * @param {Article[]} articles
 * @param {import("../analysis/signal-engine.js").Signal[]} signals
 * @returns {Promise<void>}
 */
function storeResults(articles, signals) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(
      {
        [STORAGE_KEYS.LATEST_SIGNALS]:  signals,
        [STORAGE_KEYS.LATEST_ARTICLES]: articles,
        [STORAGE_KEYS.LAST_FETCH_TIME]: Date.now()
      },
      () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      }
    );
  });
}

// ─── Badge ────────────────────────────────────────────────────────────────────

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

// ─── Alarm ────────────────────────────────────────────────────────────────────

function scheduleAlarm() {
  chrome.alarms.create(REFRESH_ALARM_NAME, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });
}
