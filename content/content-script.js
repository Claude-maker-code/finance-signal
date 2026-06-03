// Injected on every Yahoo Finance page the user navigates to.
// Sends the rendered page HTML to the service worker for analysis.
//
// Yahoo Finance is a React SPA — content is rendered asynchronously after
// window.load fires. We retry until news links are present in the DOM
// before sending, so the service worker always receives populated HTML.

const RETRY_DELAY_MS  = 1200; // wait between retries
const MAX_RETRIES     = 6;    // up to ~7 seconds of retries
const MIN_NEWS_LINKS  = 5;    // consider page ready when this many /news/ links exist

/**
 * Sends the current document HTML to the service worker.
 */
function reportPageHtml() {
  chrome.runtime.sendMessage({
    type: "PAGE_HTML_REPORT",
    html: document.documentElement.outerHTML
  }).catch(() => {
    // Service worker may be inactive on a cold extension start — safe to ignore.
  });
}

/**
 * Waits until Yahoo Finance has rendered enough news links, then reports.
 * Falls back to sending whatever is available after MAX_RETRIES attempts.
 * @param {number} retriesLeft
 */
function waitForContentThenReport(retriesLeft) {
  const newsLinkCount = document.querySelectorAll('a[href*="/news/"]').length;

  if (newsLinkCount >= MIN_NEWS_LINKS || retriesLeft === 0) {
    reportPageHtml();
  } else {
    setTimeout(() => waitForContentThenReport(retriesLeft - 1), RETRY_DELAY_MS);
  }
}

// Start the readiness check once the initial DOM is available.
if (document.readyState === "complete") {
  waitForContentThenReport(MAX_RETRIES);
} else {
  window.addEventListener("load", () => waitForContentThenReport(MAX_RETRIES), { once: true });
}

// Respond to on-demand requests from the service worker
// (triggered when the user clicks the refresh button in the popup).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_HTML") {
    // Return whatever is currently rendered — caller is asking explicitly
    sendResponse({ html: document.documentElement.outerHTML });
  }
  return false;
});
