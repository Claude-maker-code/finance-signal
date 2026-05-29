// Injected on every Yahoo Finance page the user navigates to.
// Proactively sends the page HTML to the service worker for analysis,
// and responds to on-demand requests from the service worker.

/**
 * Sends the current page HTML to the service worker.
 * Called once the page is fully loaded so JS-rendered content is available.
 */
function reportPageHtml() {
  chrome.runtime.sendMessage({
    type: "PAGE_HTML_REPORT",
    html: document.documentElement.outerHTML
  }).catch(() => {
    // Service worker may not be active yet on a cold start — safe to ignore.
  });
}

if (document.readyState === "complete") {
  reportPageHtml();
} else {
  window.addEventListener("load", reportPageHtml, { once: true });
}

// Respond to on-demand requests from the service worker
// (used when the user clicks the Refresh button in the popup).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_HTML") {
    sendResponse({ html: document.documentElement.outerHTML });
  }
  return false;
});
