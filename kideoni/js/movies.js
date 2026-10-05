// js/movies.js
// Reads only PUBLIC metadata (title, poster, synopsis...) directly from
// Supabase — this is safe because RLS only exposes published rows, and the
// actual video file path/URL is never selected or rendered here. Real
// playback URLs are only ever obtained from the get-video-url Edge
// Function at watch time.

function posterCardHTML(movie) {
  const badge = movie.is_free ? `<span class="poster-badge">FREE</span>` : "";
  const poster = movie.poster_url || placeholderPoster(movie.title);
  return `
    <a class="poster-card" href="watch.html?type=movie&id=${movie.id}">
      ${badge}
      <img src="${poster}" alt="${escapeHtml(movie.title)}" loading="lazy" />
      <div class="poster-meta">
        <strong>${escapeHtml(movie.title)}</strong>
        <span>${movie.release_year ?? ""} ${movie.genres?.length ? "· " + movie.genres[0] : ""}</span>
      </div>
    </a>`;
}

function reelCardHTML(reel) {
  const thumb = reel.thumbnail_url || placeholderPoster(reel.title, "9:16");
  return `
    <a class="reel-card" href="reels.html?open=${reel.id}">
      <img src="${thumb}" alt="${escapeHtml(reel.title)}" loading="lazy" />
      <div class="reel-play">▶</div>
      <div class="poster-meta"><strong style="font-size:12px;">${escapeHtml(reel.title)}</strong></div>
    </a>`;
}

function placeholderPoster(title, ratio) {
  const label = encodeURIComponent((title || "KIDEONI").slice(0, 18));
  const size = ratio === "9:16" ? "300x534" : "300x450";
  return `https://placehold.co/${size}/151517/F25A24?text=${label}&font=roboto`;
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadHome() {
  const [reels, freeMovies, trending] = await Promise.all([
    window.sb.from("reels").select("id, title, caption, thumbnail_url, related_movie_id, duration_seconds, is_published, view_count, like_count, created_at").eq("is_published", true).order("created_at", { ascending: false }).limit(8),
    window.sb.from("movies").select("id, title, slug, synopsis, poster_url, backdrop_url, trailer_url, duration_seconds, release_year, genres, cast_list, rating, is_free, is_published, is_featured, view_count, created_at").eq("is_published", true).eq("is_free", true).order("created_at", { ascending: false }).limit(8),
    window.sb.from("movies").select("id, title, slug, synopsis, poster_url, backdrop_url, trailer_url, duration_seconds, release_year, genres, cast_list, rating, is_free, is_published, is_featured, view_count, created_at").eq("is_published", true).order("view_count", { ascending: false }).limit(8),
  ]);

  if (reels.error) console.error("KIDEONI reels query error:", reels.error);
  if (freeMovies.error) console.error("KIDEONI free-movies query error:", freeMovies.error);
  if (trending.error) console.error("KIDEONI trending query error:", trending.error);

  renderRow("reelsRow", reels.data, reelCardHTML, reels.error ? `Couldn't load reels: ${reels.error.message}` : "No reels yet — check back soon.");
  renderRow("freeMoviesRow", freeMovies.data, posterCardHTML, freeMovies.error ? `Couldn't load movies: ${freeMovies.error.message}` : "No free movies right now.");
  renderRow("trendingRow", trending.data, posterCardHTML, trending.error ? `Couldn't load movies: ${trending.error.message}` : "Nothing trending yet.");

  // Feature the top trending title in the hero, if we have one
  if (trending.data?.[0]) {
    const m = trending.data[0];
    const heroBanner = document.getElementById("heroBanner");
    const heroTitle = document.getElementById("heroTitle");
    const heroSynopsis = document.getElementById("heroSynopsis");
    if (m.backdrop_url && heroBanner) {
      heroBanner.style.backgroundImage = `linear-gradient(0deg, rgba(10,10,11,1), rgba(10,10,11,0.2)), url('${m.backdrop_url}')`;
    }
    if (heroTitle) heroTitle.textContent = m.title;
    if (heroSynopsis && m.synopsis) heroSynopsis.textContent = m.synopsis;
    if (heroBanner) heroBanner.querySelector(".btn-primary").href = `watch.html?type=movie&id=${m.id}`;
  }
}

function renderRow(elId, items, cardFn, emptyMsg) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!items || items.length === 0) {
    el.innerHTML = `<p class="muted">${emptyMsg}</p>`;
    return;
  }
  el.innerHTML = items.map(cardFn).join("");
}

// -------------------- Browse page (grid + filters + search) --------------------
async function loadBrowse() {
  const grid = document.getElementById("browseGrid");
  const search = document.getElementById("searchInput");
  const genreSelect = document.getElementById("genreFilter");
  const sortSelect = document.getElementById("sortSelect");
  const freeOnly = document.getElementById("freeOnlyToggle");
  const freeOnlyPill = document.getElementById("freeOnlyPill");

  const params = new URLSearchParams(location.search);
  if (params.get("filter") === "free" && freeOnly) {
    freeOnly.checked = true;
    freeOnlyPill?.classList.add("active");
  }

  async function run() {
    grid.innerHTML = Array.from({ length: 10 }).map(() => `<div class="poster-card skeleton"></div>`).join("");
    let query = window.sb.from("movies").select("id, title, slug, synopsis, poster_url, backdrop_url, trailer_url, duration_seconds, release_year, genres, cast_list, rating, is_free, is_published, is_featured, view_count, created_at").eq("is_published", true);
    if (freeOnly?.checked) query = query.eq("is_free", true);
    if (genreSelect?.value) query = query.contains("genres", [genreSelect.value]);
    if (search?.value.trim()) query = query.ilike("title", `%${search.value.trim()}%`);

    switch (sortSelect?.value) {
      case "popular": query = query.order("view_count", { ascending: false }); break;
      case "az": query = query.order("title", { ascending: true }); break;
      default: query = query.order("created_at", { ascending: false });
    }

    const { data, error } = await query;
    if (error) {
      console.error("KIDEONI browse query error:", error);
      grid.innerHTML = `<div class="empty-state">Couldn't load movies: ${error.message}</div>`;
      return;
    }
    if (!data.length) {
      grid.innerHTML = `<div class="empty-state">No titles match your filters yet — try clearing a filter.</div>`;
      return;
    }
    grid.innerHTML = data.map((m, i) => posterCardHTML(m).replace("poster-card", `poster-card" style="--i:${i}`)).join("");
  }

  [search, genreSelect, sortSelect].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", debounce(run, 250));
    el.addEventListener("change", run);
  });

  freeOnly?.addEventListener("change", () => {
    freeOnlyPill?.classList.toggle("active", freeOnly.checked);
    run();
  });

  run();
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
