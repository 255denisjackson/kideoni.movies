// js/payments.js
// Renders plans (public data) and starts checkout. The actual charge and
// the PayIn secret key live entirely in the create-payment / payin-webhook
// Edge Functions — this file only ever calls those functions and never
// talks to PayIn directly.

let selectedPlan = null;

function planCardHTML(plan, featured) {
  const priceLabel = Number(plan.price) === 0 ? "Free" : formatMoney(plan.price, plan.currency);
  const period = Number(plan.price) === 0 ? "" : plan.duration_days >= 365 ? "/year" : "/month";
  return `
    <div class="plan-card ${featured ? "featured" : ""}">
      <div class="plan-name">${plan.name}</div>
      <p class="muted">${plan.description || ""}</p>
      <div class="plan-price">${priceLabel} <span>${period}</span></div>
      <ul class="plan-features">
        ${(plan.features || []).map((f) => `<li>${f}</li>`).join("")}
      </ul>
      <button class="btn ${featured ? "btn-primary" : "btn-ghost"} btn-block" onclick="startCheckout('${plan.id}')">
        ${Number(plan.price) === 0 ? "Get started" : "Choose plan"}
      </button>
    </div>`;
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat("en-TZ", { style: "currency", currency: currency || "TZS", maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

async function loadPlans() {
  const grid = document.getElementById("plansGrid");
  const { data: plans, error } = await window.sb.from("plans").select("*").eq("is_active", true).order("sort_order");
  if (error || !plans?.length) {
    grid.innerHTML = `<p class="muted">Plans aren't available right now — please check back shortly.</p>`;
    return;
  }
  const featuredIndex = Math.min(2, plans.length - 1);
  grid.innerHTML = plans.map((p, i) => planCardHTML(p, i === featuredIndex)).join("");
  window.__plans = plans;
}

async function startCheckout(planId) {
  const {
    data: { session },
  } = await window.sb.auth.getSession();
  if (!session) {
    location.href = `login.html?redirect=pricing.html`;
    return;
  }

  selectedPlan = window.__plans.find((p) => p.id === planId);
  if (!selectedPlan) return;

  if (Number(selectedPlan.price) === 0) {
    await window.callFunction("create-payment", { plan_id: planId });
    alert("You're on the Free plan. Enjoy KIDEONI Reels!");
    return;
  }

  document.getElementById("checkoutPlanLabel").textContent = `${selectedPlan.name} — ${formatMoney(selectedPlan.price, selectedPlan.currency)}`;
  document.getElementById("checkoutModal").style.display = "flex";
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("closeCheckout")?.addEventListener("click", () => {
    document.getElementById("checkoutModal").style.display = "none";
  });

  document.getElementById("payBtn")?.addEventListener("click", async () => {
    const btn = document.getElementById("payBtn");
    const msg = document.getElementById("checkoutMsg");
    const phone = document.getElementById("phoneInput").value.trim();

    msg.className = "form-msg";
    if (!phone) {
      msg.textContent = "Enter the mobile money number you'll pay with.";
      msg.classList.add("show", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Starting payment…";
    try {
      const res = await window.callFunction("create-payment", { plan_id: selectedPlan.id, phone });
      if (res.checkout_url) {
        location.href = res.checkout_url;
        return;
      }
      msg.textContent = res.instructions || "Approve the payment prompt on your phone, then refresh this page.";
      msg.classList.add("show", "success");
      btn.textContent = "Waiting for confirmation…";
    } catch (e) {
      msg.textContent = e.message || "Payment could not be started.";
      msg.classList.add("show", "error");
      btn.disabled = false;
      btn.textContent = "Pay with PayIn";
    }
  });
});
