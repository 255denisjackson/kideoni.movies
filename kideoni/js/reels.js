// js/reels.js — vertical swipe feed (reels are always free, but every play
// still goes through the same signed-URL + tracked-view pipeline as movies).
(async function initReels() {
  const feed = document.getElementById("reelsFeed");
  const { data: reels, error } = await window.sb
    .from("reels")
    .select("id, title, caption, thumbnail_url, related_movie_id, duration_seconds, is_published, view_count, like_count, created_at")
    .eq("is_published", true)
    .order("created_at", { ascending: false });

  if (error || !reels?.length) {
    console.error("KIDEONI reels query error:", error);
    feed.innerHTML = `<p class="muted center" style="padding-top:120px; padding-inline:20px;">
      ${error ? `Couldn't load reels: ${escapeHtml(error.message)}` : "No reels available yet."}
    </p>`;
    return;
  }

  feed.innerHTML = reels
    .map(
      (r, i) => `
    <div class="reel-slide" data-id="${r.id}" data-index="${i}">
      <video muted loop playsinline poster="${r.thumbnail_url || ""}"></video>
      <div class="reel-tap-hint">▶</div>
      <div class="reel-info">
        <strong>${escapeHtml(r.title)}</strong>
        ${r.caption ? `<span>${escapeHtml(r.caption)}</span>` : ""}
      </div>
    </div>`
    )
    .join("");

  const slides = Array.from(feed.querySelectorAll(".reel-slide"));
  const loaded = new Set();

  async function activate(slide) {
    const id = slide.dataset.id;
    const video = slide.querySelector("video");
    const hint = slide.querySelector(".reel-tap-hint");

    if (!loaded.has(id)) {
      loaded.add(id);
      await loadProtectedVideo(video, "reel", id, () => {
        hint.textContent = "⚠";
        hint.style.opacity = "1";
      });
    }
    video.play().catch(() => {
      hint.style.opacity = "1"; // autoplay blocked — invite a tap
    });
  }

  function pause(slide) {
    slide.querySelector("video")?.pause();
  }

  slides.forEach((slide) => {
    const video = slide.querySelector("video");
    const hint = slide.querySelector(".reel-tap-hint");
    video.addEventListener("click", () => {
      if (video.paused) {
        video.play();
        hint.style.opacity = "0";
      } else {
        video.pause();
        hint.style.opacity = "1";
      }
    });
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
          activate(entry.target);
        } else {
          pause(entry.target);
        }
      });
    },
    { root: feed, threshold: [0, 0.6, 1] }
  );
  slides.forEach((s) => observer.observe(s));

  // Deep link: ?open=<reel_id> scrolls straight to that reel
  const params = new URLSearchParams(location.search);
  const openId = params.get("open");
  if (openId) {
    const target = slides.find((s) => s.dataset.id === openId);
    target?.scrollIntoView({ block: "start" });
  }

  function escapeHtml(str = "") {
    return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
