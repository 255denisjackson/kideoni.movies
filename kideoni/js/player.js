// js/player.js
// Shared logic for both the movie player (watch.html) and the reels feed.
// Responsible for:
//   1. Asking the get-video-url Edge Function for a short-lived signed URL
//      (never storing or guessing the storage path client-side).
//   2. Sending heartbeats to track-view so analytics are recorded
//      server-side, tamper-proof, per viewing session.
//   3. Basic anti-download friction on the <video> element (this deters
//      casual copying; it cannot make browser video 100% undownloadable —
//      no web player can — so treat it as one layer, not the only one).

function newSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function hardenVideoElement(video) {
  video.setAttribute("controlsList", "nodownload noremoteplayback");
  video.setAttribute("disablePictureInPicture", "");
  video.setAttribute("oncontextmenu", "return false;");
  video.addEventListener("contextmenu", (e) => e.preventDefault());
}

/**
 * Loads protected content into a <video> element and wires up analytics.
 * @param {HTMLVideoElement} video
 * @param {'movie'|'reel'} type
 * @param {string} id
 * @param {(err:Error)=>void} onError
 */
async function loadProtectedVideo(video, type, id, onError) {
  hardenVideoElement(video);
  const sessionId = newSessionId();
  let heartbeatTimer = null;
  let lastPercent = 0;

  async function fetchAndSet() {
    try {
      const { url } = await window.callFunction("get-video-url", { content_type: type, content_id: id });
      video.src = url;
      return true;
    } catch (e) {
      onError?.(e);
      return false;
    }
  }

  const ok = await fetchAndSet();
  if (!ok) return null;

  function currentPercent() {
    if (!video.duration || isNaN(video.duration)) return 0;
    return Math.min(100, Math.round((video.currentTime / video.duration) * 100));
  }

  async function sendHeartbeat(completed = false) {
    lastPercent = currentPercent();
    try {
      await window.callFunction("track-view", {
        content_type: type,
        content_id: id,
        session_id: sessionId,
        watch_seconds: Math.floor(video.currentTime || 0),
        percent_complete: lastPercent,
        completed,
        device: navigator.userAgent,
      });
    } catch (_) {
      /* analytics must never break playback */
    }
  }

  video.addEventListener("playing", () => {
    if (heartbeatTimer) return;
    sendHeartbeat(false);
    heartbeatTimer = setInterval(() => sendHeartbeat(false), 15000);
  });
  video.addEventListener("pause", () => sendHeartbeat(false));
  video.addEventListener("ended", () => sendHeartbeat(true));
  window.addEventListener("beforeunload", () => {
    if (video.currentTime > 0) navigator.sendBeacon?.(
      `${window.KIDEONI_CONFIG.FUNCTIONS_URL}/track-view`,
      new Blob([JSON.stringify({
        content_type: type, content_id: id, session_id: sessionId,
        watch_seconds: Math.floor(video.currentTime), percent_complete: currentPercent(), completed: false,
      })], { type: "application/json" })
    );
  });

  // Re-mint the signed URL if it expires mid-playback (long movies)
  video.addEventListener("stalled", async () => {
    if (video.readyState === 0) await fetchAndSet();
  });

  return { sessionId, sendHeartbeat };
}
