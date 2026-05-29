import { STORAGE_KEYS } from "../shared/constants.js";

/**
 * @typedef {Object} FeedbackEntry
 * @property {string} signalId - ID of the signal being rated
 * @property {string} ticker
 * @property {"up"|"down"} rating
 * @property {string} note - Optional user-provided context
 * @property {number} recordedAt - Unix timestamp in milliseconds
 */

/**
 * Saves a feedback entry to storage.
 * If feedback already exists for the same signalId, it is overwritten.
 *
 * @param {FeedbackEntry} entry
 * @returns {Promise<void>}
 */
export async function saveFeedback(entry) {
  const log = await loadFeedbackLog();

  // Remove any existing entry for the same signal to avoid duplicates
  const filtered = log.filter(existing => existing.signalId !== entry.signalId);
  filtered.push(entry);

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.FEEDBACK_LOG]: filtered }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Loads all feedback entries from storage.
 * @returns {Promise<FeedbackEntry[]>}
 */
export async function loadFeedbackLog() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.FEEDBACK_LOG], result => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(result[STORAGE_KEYS.FEEDBACK_LOG] || []);
      }
    });
  });
}

/**
 * Returns the feedback entry for a specific signal, or null if none exists.
 * @param {string} signalId
 * @returns {Promise<FeedbackEntry|null>}
 */
export async function getFeedbackForSignal(signalId) {
  const log = await loadFeedbackLog();
  return log.find(entry => entry.signalId === signalId) || null;
}

/**
 * Returns all feedback entries for a given ticker symbol.
 * @param {string} ticker
 * @returns {Promise<FeedbackEntry[]>}
 */
export async function getFeedbackForTicker(ticker) {
  const log = await loadFeedbackLog();
  return log.filter(entry => entry.ticker === ticker);
}
