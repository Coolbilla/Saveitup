// This script runs on every page (manifest content_scripts match <all_urls>),
// so any website could plant a #saveitup-session-marker element and trick a
// naive version of this script into asking the background page to open an
// attacker-controlled list of tabs. Only wire up the button when the page is
// actually being served by the backend the user configured — never trust
// location.origin on its own.
(async () => {
  const marker = document.getElementById("saveitup-session-marker");
  if (!marker) return;
  const sessionId = marker.dataset.sessionId;
  if (!sessionId) return;

  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  if (!apiBase) return;
  let trustedOrigin: string;
  try {
    trustedOrigin = new URL(apiBase).origin;
  } catch {
    return;
  }
  if (location.origin !== trustedOrigin) return;

  const btn = document.createElement("button");
  btn.textContent = "Open with SaveItUp →";
  btn.style.display = "block";
  btn.style.margin = "0 0 12px";
  btn.style.fontSize = "14px";
  btn.style.padding = "10px 16px";
  btn.style.border = "none";
  btn.style.borderRadius = "8px";
  btn.style.background = "#16a34a";
  btn.style.color = "#fff";
  btn.style.cursor = "pointer";

  btn.addEventListener("click", () => {
    btn.disabled = true;
    btn.textContent = "Opening...";
    chrome.runtime.sendMessage(
      { type: "saveitup-open-tab-session", sessionId, apiOrigin: location.origin },
      (response) => {
        btn.disabled = false;
        btn.textContent = response?.ok ? "Opened ✓" : "Failed — try again";
      }
    );
  });

  marker.parentNode?.insertBefore(btn, marker);
})();
