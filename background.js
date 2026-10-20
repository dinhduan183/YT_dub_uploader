chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Khi extension tự cập nhật lên bản mới → đánh dấu để side panel hiện khung "Có gì mới" 1 lần
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'update') {
    chrome.storage.local.set({ whatsNewVersion: chrome.runtime.getManifest().version });
  }
});
