// js/nav.js — shared across every page. Updates the nav's auth area and
// wires the mobile menu toggle. Requires supabaseClient.js loaded first.
(async function initNav() {
  const authSlot = document.getElementById("navAuthSlot");
  if (!authSlot) return;

  function renderSignedOut() {
    authSlot.innerHTML = `
      <a href="login.html" class="btn btn-ghost btn-sm">Sign in</a>
      <a href="signup.html" class="btn btn-primary btn-sm">Join now</a>
    `;
  }

  function renderSignedIn(user, isAdmin) {
    const initial = (user.email || "U").charAt(0).toUpperCase();
    authSlot.innerHTML = `
      ${isAdmin ? `<a href="admin/index.html" class="btn btn-ghost btn-sm">Admin</a>` : ""}
      <a href="account.html" class="avatar-btn" title="${user.email}">${initial}</a>
    `;
  }

  const {
    data: { session },
  } = await window.sb.auth.getSession();

  if (session?.user) {
    const { data: profile } = await window.sb
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single();
    renderSignedIn(session.user, profile?.role === "admin");
  } else {
    renderSignedOut();
  }

  window.sb.auth.onAuthStateChange((_event, s) => {
    if (s?.user) renderSignedIn(s.user, false);
    else renderSignedOut();
  });

  const toggle = document.getElementById("navToggle");
  const links = document.getElementById("navLinks");
  if (toggle && links) {
    toggle.addEventListener("click", () => links.classList.toggle("open"));
  }
})();
