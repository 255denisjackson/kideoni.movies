// js/custom-player.js
// Fully custom playback controls. The <video> element never gets the
// native "controls" attribute, so there is no browser-native overflow /
// "..." menu and therefore no built-in "Download" option anywhere in the
// player — only the buttons we draw here exist.
function initCustomPlayer(video, root) {
  const centerBtn = root.querySelector("#kvCenterBtn");
  const playBtn = root.querySelector("#kvPlayBtn");
  const backBtn = root.querySelector("#kvBackBtn");
  const fwdBtn = root.querySelector("#kvFwdBtn");
  const timeLabel = root.querySelector("#kvTime");
  const muteBtn = root.querySelector("#kvMuteBtn");
  const volumeSlider = root.querySelector("#kvVolume");
  const fullscreenBtn = root.querySelector("#kvFullscreenBtn");
  const progress = root.querySelector("#kvProgress");
  const buffered = root.querySelector("#kvBuffered");
  const played = root.querySelector("#kvPlayed");
  const handle = root.querySelector("#kvHandle");
  const controlsBar = root.querySelector("#kvControls");
  const flashLeft = root.querySelector("#kvFlashLeft");
  const flashRight = root.querySelector("#kvFlashRight");
  const frame = video.closest(".player-frame") || root.parentElement;

  const SKIP_SECONDS = 10;
  let hideTimer = null;
  let scrubbing = false;

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}:${(m % 60).toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  function updatePlayIcon() {
    const icon = video.paused ? "▶" : "❚❚";
    playBtn.textContent = icon;
    centerBtn.textContent = video.paused ? "▶" : "❚❚";
  }

  function togglePlay() {
    if (video.paused) video.play();
    else video.pause();
  }

  function flashCenter() {
    centerBtn.classList.add("show");
    clearTimeout(flashCenter._t);
    flashCenter._t = setTimeout(() => {
      if (!video.paused) centerBtn.classList.remove("show");
    }, 500);
  }

  function skip(seconds) {
    video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), video.duration || Infinity);
    const flashEl = seconds < 0 ? flashLeft : flashRight;
    flashEl.classList.add("show");
    clearTimeout(flashEl._t);
    flashEl._t = setTimeout(() => flashEl.classList.remove("show"), 450);
    showControlsTemporarily();
  }

  function showControlsTemporarily() {
    controlsBar.classList.remove("hidden");
    root.classList.remove("hide-cursor");
    clearTimeout(hideTimer);
    if (!video.paused) {
      hideTimer = setTimeout(() => {
        controlsBar.classList.add("hidden");
        root.classList.add("hide-cursor");
        centerBtn.classList.remove("show");
      }, 2800);
    }
  }

  function renderProgress() {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    played.style.width = `${pct}%`;
    handle.style.left = `${pct}%`;
    timeLabel.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;

    if (video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      buffered.style.width = `${Math.min(100, (end / video.duration) * 100)}%`;
    }
  }

  function seekFromEvent(e) {
    const rect = progress.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (video.duration) video.currentTime = ratio * video.duration;
    renderProgress();
  }

  // ---- wire events ----
  centerBtn.addEventListener("click", togglePlay);
  playBtn.addEventListener("click", togglePlay);
  backBtn.addEventListener("click", () => skip(-SKIP_SECONDS));
  fwdBtn.addEventListener("click", () => skip(SKIP_SECONDS));

  root.addEventListener("click", (e) => {
    if (e.target === root) {
      togglePlay();
      flashCenter();
    }
  });
  // Double-tap/click left or right half of the frame to skip (mobile-friendly)
  root.addEventListener("dblclick", (e) => {
    const rect = root.getBoundingClientRect();
    const isLeft = e.clientX - rect.left < rect.width / 2;
    skip(isLeft ? -SKIP_SECONDS : SKIP_SECONDS);
  });

  muteBtn.addEventListener("click", () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  });
  volumeSlider.addEventListener("input", () => {
    video.volume = Number(volumeSlider.value);
    video.muted = video.volume === 0;
    muteBtn.textContent = video.muted ? "🔇" : "🔊";
  });

  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else frame.requestFullscreen?.();
  });

  progress.addEventListener("pointerdown", (e) => {
    scrubbing = true;
    seekFromEvent(e);
  });
  window.addEventListener("pointermove", (e) => {
    if (scrubbing) seekFromEvent(e);
  });
  window.addEventListener("pointerup", () => {
    scrubbing = false;
  });

  video.addEventListener("play", () => {
    updatePlayIcon();
    showControlsTemporarily();
  });
  video.addEventListener("pause", () => {
    updatePlayIcon();
    controlsBar.classList.remove("hidden");
    root.classList.remove("hide-cursor");
    centerBtn.classList.add("show");
    clearTimeout(hideTimer);
  });
  video.addEventListener("timeupdate", () => {
    if (!scrubbing) renderProgress();
  });
  video.addEventListener("loadedmetadata", renderProgress);
  video.addEventListener("progress", renderProgress);

  root.addEventListener("mousemove", showControlsTemporarily);
  root.addEventListener("touchstart", showControlsTemporarily, { passive: true });

  // Keyboard shortcuts (space = play/pause, arrows = skip)
  document.addEventListener("keydown", (e) => {
    if (!document.body.contains(video) || !frame.contains(document.activeElement) && document.activeElement !== document.body) {
      // allow shortcuts even when nothing is focused inside the frame
    }
    if (["Space", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      if (e.code === "Space") { e.preventDefault(); togglePlay(); flashCenter(); }
      if (e.code === "ArrowLeft") skip(-SKIP_SECONDS);
      if (e.code === "ArrowRight") skip(SKIP_SECONDS);
    }
  });

  updatePlayIcon();
  centerBtn.classList.add("show");
}
