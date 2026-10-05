// js/admin-content.js
// All writes here go straight to Supabase from the browser, which is safe
// because movies/reels INSERT/UPDATE/DELETE policies check public.is_admin()
// server-side (see schema.sql) — a non-admin session gets rejected by RLS
// regardless of what the client sends. Video files upload straight into the
// private 'videos' storage bucket under the same admin-only policy; no
// secret key is ever needed in this file.

let allMovies = [];
let allReels = [];

// ---------------------------------------------------------------------------
// Resumable, chunked video upload (TUS protocol). Supabase's own single-shot
// storage.upload() can time out or fail outright on large 4K/2K files — this
// uploads in 6MB chunks, can resume if the connection drops, and reports
// real progress. Uses the admin's own session token, so it's still governed
// by the "videos_admin_all" RLS policy — no service-role key involved.
// ---------------------------------------------------------------------------
async function uploadVideoResumable(file, storagePath, { onProgress } = {}) {
  const {
    data: { session },
  } = await window.sb.auth.getSession();
  if (!session) throw new Error("Your session expired — please sign in again.");

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${window.KIDEONI_CONFIG.SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      chunkSize: 6 * 1024 * 1024, // required by Supabase's TUS implementation
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: window.KIDEONI_CONFIG.SUPABASE_ANON_KEY,
        "x-upsert": "true",
      },
      metadata: {
        bucketName: "videos",
        objectName: storagePath,
        contentType: file.type || "video/mp4",
        cacheControl: "3600",
      },
      onError: (error) => reject(error),
      onProgress: (bytesUploaded, bytesTotal) => {
        onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
      },
      onSuccess: () => resolve(),
    });

    // Resume an interrupted upload of the same file instead of restarting it
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}

(async function initAdminContent() {
  const profile = await requireAdmin();
  if (!profile) return;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("moviesTab").style.display = btn.dataset.tab === "movies" ? "block" : "none";
      document.getElementById("reelsTab").style.display = btn.dataset.tab === "reels" ? "block" : "none";
    });
  });

  await loadMovies();
  await loadReels();

  document.getElementById("movieSearch").addEventListener("input", (e) => renderMovies(e.target.value));
  document.getElementById("reelSearch").addEventListener("input", (e) => renderReels(e.target.value));

  document.getElementById("newMovieBtn").addEventListener("click", () => openMovieModal());
  document.getElementById("cancelMovieBtn").addEventListener("click", () => closeModal("movieModal"));
  document.getElementById("movieForm").addEventListener("submit", saveMovie);

  document.getElementById("newReelBtn").addEventListener("click", () => openReelModal());
  document.getElementById("cancelReelBtn").addEventListener("click", () => closeModal("reelModal"));
  document.getElementById("reelForm").addEventListener("submit", saveReel);
})();

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
function openModal(id) {
  document.getElementById(id).classList.add("open");
}

// ---------------- Movies ----------------
async function loadMovies() {
  const { data } = await window.sb.from("movies").select("*").order("created_at", { ascending: false });
  allMovies = data || [];
  renderMovies();
}

function renderMovies(filter = "") {
  const body = document.getElementById("moviesBody");
  const rows = allMovies.filter((m) => m.title.toLowerCase().includes(filter.toLowerCase()));
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="muted">No movies found.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (m) => `
    <tr>
      <td><img class="thumb" src="${m.poster_url || "https://placehold.co/60x84/151517/F25A24?text=%20"}" /></td>
      <td>${escapeHtml(m.title)}</td>
      <td><span class="chip ${m.is_published ? "published" : "draft"}">${m.is_published ? "Published" : "Draft"}</span></td>
      <td>${m.is_free ? `<span class="chip free">Free</span>` : "—"}</td>
      <td>${m.view_count ?? 0}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openMovieModal('${m.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteMovie('${m.id}')">Delete</button>
      </td>
    </tr>`
    )
    .join("");
}

function openMovieModal(id) {
  const form = document.getElementById("movieForm");
  form.reset();
  document.getElementById("movieMsg").className = "form-msg";
  document.getElementById("currentPathLabel").textContent = "";
  document.getElementById("movieUploadTrack").style.display = "none";
  document.getElementById("movieUploadFill").style.width = "0%";
  document.getElementById("movieUploadPct").textContent = "";
  const movie = allMovies.find((m) => m.id === id);
  document.getElementById("movieModalTitle").textContent = movie ? "Edit movie" : "Add movie";
  form.id.value = movie?.id || "";
  if (movie) {
    form.title.value = movie.title;
    form.slug.value = movie.slug;
    form.synopsis.value = movie.synopsis || "";
    form.release_year.value = movie.release_year || "";
    form.duration_seconds.value = movie.duration_seconds || "";
    form.genres.value = (movie.genres || []).join(", ");
    form.poster_url.value = movie.poster_url || "";
    form.backdrop_url.value = movie.backdrop_url || "";
    form.is_free.checked = !!movie.is_free;
    form.is_published.checked = !!movie.is_published;
    form.is_featured.checked = !!movie.is_featured;
    if (movie.storage_path) document.getElementById("currentPathLabel").textContent = `Current file: ${movie.storage_path}`;
  }
  openModal("movieModal");
}

async function saveMovie(e) {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById("movieMsg");
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving…";

  const track = document.getElementById("movieUploadTrack");
  const fill = document.getElementById("movieUploadFill");
  const pctLabel = document.getElementById("movieUploadPct");

  try {
    const id = form.id.value || null;
    let storage_path;

    const file = form.videoFile.files[0];
    if (file) {
      storage_path = `movies/${form.slug.value}-${Date.now()}.${file.name.split(".").pop()}`;
      track.style.display = "block";
      fill.style.width = "0%";
      pctLabel.textContent = `Uploading ${(file.size / (1024 * 1024)).toFixed(0)} MB… 0%`;
      btn.textContent = "Uploading…";

      await uploadVideoResumable(file, storage_path, {
        onProgress: (pct) => {
          fill.style.width = `${pct}%`;
          pctLabel.textContent = `Uploading… ${pct}%`;
        },
      });
      pctLabel.textContent = "Upload complete ✓";
      btn.textContent = "Saving…";
    }

    const payload = {
      title: form.title.value.trim(),
      slug: form.slug.value.trim(),
      synopsis: form.synopsis.value.trim(),
      release_year: form.release_year.value ? Number(form.release_year.value) : null,
      duration_seconds: form.duration_seconds.value ? Number(form.duration_seconds.value) : null,
      genres: form.genres.value.split(",").map((g) => g.trim()).filter(Boolean),
      poster_url: form.poster_url.value.trim() || null,
      backdrop_url: form.backdrop_url.value.trim() || null,
      is_free: form.is_free.checked,
      is_published: form.is_published.checked,
      is_featured: form.is_featured.checked,
    };
    if (storage_path) payload.storage_path = storage_path;

    const { error } = id
      ? await window.sb.from("movies").update(payload).eq("id", id)
      : await window.sb.from("movies").insert(payload);

    if (error) throw error;

    closeModal("movieModal");
    await loadMovies();
  } catch (err) {
    msg.textContent = err.message || "Could not save movie.";
    msg.className = "form-msg show error";
    pctLabel.textContent = "";
    track.style.display = "none";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save movie";
  }
}

async function deleteMovie(id) {
  if (!confirm("Delete this movie? This cannot be undone.")) return;
  await window.sb.from("movies").delete().eq("id", id);
  await loadMovies();
}

// ---------------- Reels ----------------
async function loadReels() {
  const { data } = await window.sb.from("reels").select("*").order("created_at", { ascending: false });
  allReels = data || [];
  renderReels();
}

function renderReels(filter = "") {
  const body = document.getElementById("reelsBody");
  const rows = allReels.filter((r) => r.title.toLowerCase().includes(filter.toLowerCase()));
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">No reels found.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td><img class="thumb" src="${r.thumbnail_url || "https://placehold.co/60x84/151517/F25A24?text=%20"}" /></td>
      <td>${escapeHtml(r.title)}</td>
      <td><span class="chip ${r.is_published ? "published" : "draft"}">${r.is_published ? "Published" : "Draft"}</span></td>
      <td>${r.view_count ?? 0}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openReelModal('${r.id}')">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteReel('${r.id}')">Delete</button>
      </td>
    </tr>`
    )
    .join("");
}

function openReelModal(id) {
  const form = document.getElementById("reelForm");
  form.reset();
  document.getElementById("reelMsg").className = "form-msg";
  document.getElementById("currentReelPathLabel").textContent = "";
  document.getElementById("reelUploadTrack").style.display = "none";
  document.getElementById("reelUploadFill").style.width = "0%";
  document.getElementById("reelUploadPct").textContent = "";
  const reel = allReels.find((r) => r.id === id);
  document.getElementById("reelModalTitle").textContent = reel ? "Edit reel" : "Add reel";
  form.id.value = reel?.id || "";
  if (reel) {
    form.title.value = reel.title;
    form.caption.value = reel.caption || "";
    form.thumbnail_url.value = reel.thumbnail_url || "";
    form.is_published.checked = !!reel.is_published;
    if (reel.storage_path) document.getElementById("currentReelPathLabel").textContent = `Current file: ${reel.storage_path}`;
  }
  openModal("reelModal");
}

async function saveReel(e) {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById("reelMsg");
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Saving…";

  const track = document.getElementById("reelUploadTrack");
  const fill = document.getElementById("reelUploadFill");
  const pctLabel = document.getElementById("reelUploadPct");

  try {
    const id = form.id.value || null;
    let storage_path;
    const file = form.videoFile.files[0];

    if (file) {
      storage_path = `reels/${Date.now()}-${file.name}`;
      track.style.display = "block";
      fill.style.width = "0%";
      pctLabel.textContent = `Uploading ${(file.size / (1024 * 1024)).toFixed(0)} MB… 0%`;
      btn.textContent = "Uploading…";

      await uploadVideoResumable(file, storage_path, {
        onProgress: (pct) => {
          fill.style.width = `${pct}%`;
          pctLabel.textContent = `Uploading… ${pct}%`;
        },
      });
      pctLabel.textContent = "Upload complete ✓";
      btn.textContent = "Saving…";
    } else if (!id) {
      throw new Error("Please choose a video file for the new reel.");
    }

    const payload = {
      title: form.title.value.trim(),
      caption: form.caption.value.trim(),
      thumbnail_url: form.thumbnail_url.value.trim() || null,
      is_published: form.is_published.checked,
    };
    if (storage_path) payload.storage_path = storage_path;

    const { error } = id
      ? await window.sb.from("reels").update(payload).eq("id", id)
      : await window.sb.from("reels").insert(payload);

    if (error) throw error;

    closeModal("reelModal");
    await loadReels();
  } catch (err) {
    msg.textContent = err.message || "Could not save reel.";
    msg.className = "form-msg show error";
    pctLabel.textContent = "";
    track.style.display = "none";
  } finally {
    btn.disabled = false;
    btn.textContent = "Save reel";
  }
}

async function deleteReel(id) {
  if (!confirm("Delete this reel? This cannot be undone.")) return;
  await window.sb.from("reels").delete().eq("id", id);
  await loadReels();
}

function escapeHtml(str = "") {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
