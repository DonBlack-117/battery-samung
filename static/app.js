/* ═══════════════════════════════════════════════════════════
   Battery Health Monitor — Frontend Logic
   ══════════════════════════════════════════════════════════ */

"use strict";

// ── Config ────────────────────────────────────────────────
const REFRESH_MS = 30_000; // Auto-refresh interval
const CIRCUMF = 552.92; // 2π × 88  (gauge SVG radius)

// ── State ─────────────────────────────────────────────────
let chart = null;
let refreshTimer = null;
let currentModel = document.getElementById("model-select").value;
let currentDays = 30;

// ── DOM helpers ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (id) => document.getElementById(id);

// ── Health color ──────────────────────────────────────────
function healthColor(pct) {
  if (pct === null || pct === undefined) return "#475569";
  if (pct >= 90) return "#10b981";
  if (pct >= 80) return "#22c55e";
  if (pct >= 70) return "#f59e0b";
  if (pct >= 60) return "#f97316";
  return "#ef4444";
}

// ══════════════════════════════════════════════════════════
//  API CALLS
// ══════════════════════════════════════════════════════════

async function loadCurrentData() {
  try {
    const res = await fetch(`/api/current/${encodeURIComponent(currentModel)}`);
    const data = await res.json();

    if (!res.ok || data.error) {
      showError(data.error || "Error al obtener datos del dispositivo.");
      setStatus("error");
      return;
    }

    hideError();
    setStatus("ok");
    updateGauge(data);
    updateCards(data);
    updateAlerts(data);
    updateFooter();
  } catch (err) {
    showError("No se pudo conectar con el servidor. ¿Está corriendo app.py?");
    setStatus("error");
  }
}

async function loadHistory() {
  try {
    const res = await fetch(`/api/history/${currentDays}`);
    const readings = await res.json();
    renderChart(readings);
    updateChartSubtitle(readings);
  } catch (_) {
    /* silently ignore */
  }
}

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const stats = await res.json();
    updateStats(stats);
  } catch (_) {
    /* silently ignore */
  }
}

// ══════════════════════════════════════════════════════════
//  UI UPDATES — GAUGE
// ══════════════════════════════════════════════════════════

function updateGauge(data) {
  const pct = data.health_pct;
  const arc = $("gauge-arc");

  if (pct !== null && pct !== undefined) {
    const offset = CIRCUMF * (1 - pct / 100);
    arc.style.strokeDashoffset = offset;
    arc.style.stroke = healthColor(pct);

    $("gauge-pct").textContent = pct.toFixed(1) + "%";
    $("gauge-label").textContent = data.health_label || "—";
    $("gauge-label").style.color = healthColor(pct);

    const mah = data.full_mah_est
      ? Math.round(data.full_mah_est)
      : (data.current_mah ?? "—");
    $("gauge-mah").textContent = mah !== "—" ? `${mah} mAh` : "— mAh";
  } else {
    arc.style.strokeDashoffset = CIRCUMF;
    $("gauge-pct").textContent = "—";
    $("gauge-label").textContent = "Sin datos";
  }

  $("gauge-design").textContent = `${data.design_mah ?? 5000} mAh`;
  const methodShort = !data.method_used
    ? "—"
    : data.method_used.includes("sysfs")
      ? "sysfs directo"
      : data.method_used.includes("estimaci")
        ? "estimación"
        : data.method_used;
  const methodEl = $("gauge-method");
  methodEl.textContent = methodShort;
  methodEl.title = data.method_used ?? "";
}

// ══════════════════════════════════════════════════════════
//  UI UPDATES — METRIC CARDS
// ══════════════════════════════════════════════════════════

function updateCards(data) {
  // Level
  const lvl = data.level ?? 0;
  $("m-level").textContent = `${lvl}%`;
  $("level-bar-fill").style.width = `${lvl}%`;
  $("level-bar-fill").style.background =
    lvl > 50 ? "var(--blue)" : lvl > 20 ? "var(--yellow)" : "var(--red)";

  // Status
  $("m-status").textContent = data.status_name ?? "—";

  // Temperature
  const temp = data.temp_c;
  $("m-temp").textContent =
    temp !== null && temp !== undefined ? `${temp} °C` : "—";
  const mc = $("mc-temp");
  mc.classList.remove("warm", "hot");
  if (temp > 40) mc.classList.add("hot");
  else if (temp > 32) mc.classList.add("warm");

  // Voltage
  $("m-voltage").textContent = data.voltage_mv ? `${data.voltage_mv} mV` : "—";

  // Charge counter → show as current mAh
  const mah =
    data.current_mah ??
    (data.charge_counter ? Math.round(data.charge_counter / 1000) : null);
  $("m-counter").textContent = mah !== null ? `${mah} mAh` : "—";

  // Android health
  $("m-android").textContent = data.health_name ?? "—";
  $("mc-android").classList.toggle("good", data.health_name === "Bueno");
}

// ══════════════════════════════════════════════════════════
//  UI UPDATES — ALERTS
// ══════════════════════════════════════════════════════════

function updateAlerts(data) {
  const alerts = [];

  if (data.temp_c > 40)
    alerts.push({
      level: "danger",
      icon: "🔥",
      text: `Temperatura elevada: ${data.temp_c}°C`,
    });
  else if (data.temp_c > 35)
    alerts.push({
      level: "warn",
      icon: "🌡️",
      text: `Temperatura alta: ${data.temp_c}°C`,
    });

  if (data.health_pct !== null && data.health_pct < 80)
    alerts.push({
      level: "warn",
      icon: "🔋",
      text: `Salud por debajo del 80% (${data.health_pct}%)`,
    });

  if (data.health_pct !== null && data.health_pct < 60)
    alerts.push({
      level: "danger",
      icon: "⚡",
      text: "Batería deficiente — considera reemplazarla",
    });

  if (data.protect_note)
    alerts.push({
      level: "warn",
      icon: "ℹ️",
      text: "Protección de batería activa (límite al 80-85%)",
    });

  const list = $("alerts-list");
  if (alerts.length === 0) {
    list.innerHTML = '<p class="no-alerts dim">Sin alertas activas ✓</p>';
    return;
  }

  list.innerHTML = alerts
    .map(
      (a) => `
    <div class="alert-item alert-${a.level}">
      <span class="alert-icon">${a.icon}</span>
      <span>${a.text}</span>
    </div>
  `,
    )
    .join("");
}

// ══════════════════════════════════════════════════════════
//  UI UPDATES — STATS
// ══════════════════════════════════════════════════════════

function updateStats(stats) {
  $("s-total").textContent = stats.total_readings ?? "—";
  $("s-first-date").textContent = stats.first_date ?? "Sin datos";
  $("s-first-health").textContent =
    stats.first_health != null ? `${stats.first_health}%` : "—";
  $("s-last-health").textContent =
    stats.last_health != null ? `${stats.last_health}%` : "—";
  $("s-max-temp").textContent =
    stats.max_temp_c != null ? `${stats.max_temp_c} °C` : "—";

  if (stats.monthly_degradation != null) {
    const sign = stats.monthly_degradation >= 0 ? "−" : "+";
    $("s-monthly").textContent =
      `${sign}${Math.abs(stats.monthly_degradation).toFixed(3)}% / mes`;
  } else {
    $("s-monthly").textContent = "—";
  }

  if (stats.months_to_80 != null) {
    const months = stats.months_to_80;
    if (months >= 12) {
      $("s-to-80").textContent = `~${(months / 12).toFixed(1)} años`;
    } else {
      $("s-to-80").textContent = `~${months} meses`;
    }

    // Projection bar: fill = current - 80 / first - 80
    const pWrap = $("projection-wrap");
    pWrap.classList.remove("hidden");

    const first = stats.first_health ?? stats.last_health ?? 100;
    const current = stats.last_health ?? 100;
    const range = Math.max(first - 80, 1);
    const done = Math.min(Math.max(first - current, 0), range);
    const pct = (done / range) * 100;

    $("proj-fill").style.width = `${100 - pct}%`;
    $("proj-current-label").textContent = `${current}%`;
  } else {
    $("projection-wrap").classList.add("hidden");
    $("s-to-80").textContent =
      stats.total_readings < 2 ? "Insuficientes datos" : "—";
  }
}

// ══════════════════════════════════════════════════════════
//  CHART
// ══════════════════════════════════════════════════════════

function renderChart(readings) {
  const canvas = $("health-chart");
  const empty = $("chart-empty");

  if (!readings || readings.length < 2) {
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  canvas.classList.remove("hidden");
  empty.classList.add("hidden");

  const labels = readings.map((r) => {
    const d = new Date(r.timestamp);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
  });

  const healthData = readings.map((r) => r.health_pct);
  const levelData = readings.map((r) => r.level);

  const ctx = canvas.getContext("2d");

  // Gradient fill for health line
  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, "rgba(59, 130, 246, 0.35)");
  grad.addColorStop(1, "rgba(59, 130, 246, 0.0)");

  const gradLevel = ctx.createLinearGradient(0, 0, 0, 260);
  gradLevel.addColorStop(0, "rgba(16, 185, 129, 0.2)");
  gradLevel.addColorStop(1, "rgba(16, 185, 129, 0.0)");

  const datasets = [
    {
      label: "Salud (%)",
      data: healthData,
      borderColor: "#3b82f6",
      backgroundColor: grad,
      borderWidth: 2.5,
      pointRadius: readings.length < 15 ? 4 : 2,
      pointBackgroundColor: "#3b82f6",
      pointBorderColor: "#0f172a",
      pointBorderWidth: 2,
      tension: 0.35,
      fill: true,
      yAxisID: "y",
    },
    {
      label: "Carga (%)",
      data: levelData,
      borderColor: "#10b981",
      backgroundColor: gradLevel,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.35,
      fill: true,
      borderDash: [4, 4],
      yAxisID: "y",
    },
  ];

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.update("active");
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            color: "#94a3b8",
            font: { family: "Inter", size: 12 },
            usePointStyle: true,
            pointStyleWidth: 10,
          },
        },
        tooltip: {
          backgroundColor: "#0f172a",
          borderColor: "#1e2d45",
          borderWidth: 1,
          titleColor: "#f1f5f9",
          bodyColor: "#94a3b8",
          padding: 12,
          callbacks: {
            label: (ctx) =>
              ` ${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? "—"}%`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(30, 45, 69, 0.7)", drawBorder: false },
          ticks: {
            color: "#475569",
            font: { family: "Inter", size: 11 },
            maxTicksLimit: 8,
          },
          border: { display: false },
        },
        y: {
          min: Math.max(0, Math.min(...healthData.filter(Boolean)) - 5),
          max: 101,
          grid: { color: "rgba(30, 45, 69, 0.7)", drawBorder: false },
          ticks: {
            color: "#475569",
            font: { family: "Inter", size: 11 },
            callback: (v) => v + "%",
          },
          border: { display: false },
        },
      },
    },
  });
}

function updateChartSubtitle(readings) {
  const sub = $("chart-subtitle");
  if (!readings || readings.length === 0) {
    sub.textContent = "Sin datos aún";
    return;
  }
  const first = new Date(readings[0].timestamp);
  const last = new Date(readings[readings.length - 1].timestamp);
  const fmt = (d) =>
    d.toLocaleDateString("es-ES", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  sub.textContent = `${readings.length} lecturas · ${fmt(first)} → ${fmt(last)}`;
}

// ══════════════════════════════════════════════════════════
//  STATUS / FOOTER
// ══════════════════════════════════════════════════════════

function setStatus(state) {
  const dot = $("status-dot");
  dot.className = `status-dot status-${state}`;
  dot.textContent = state === "ok" ? "⬤ Conectado" : "⬤ Sin conexión";
}

function updateFooter() {
  const now = new Date();
  $("last-update").textContent =
    `Última actualización: ${now.toLocaleTimeString("es-ES")}`;
}

function showError(msg) {
  $("error-message").textContent = msg;
  $("error-banner").classList.remove("hidden");
}

function hideError() {
  $("error-banner").classList.add("hidden");
}

// ══════════════════════════════════════════════════════════
//  AUTO-REFRESH
// ══════════════════════════════════════════════════════════

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(refreshAll, REFRESH_MS);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
}

async function refreshAll() {
  await loadCurrentData();
  await loadHistory();
  await loadStats();
}

// ══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════

// Model selector
$("model-select").addEventListener("change", async (e) => {
  currentModel = e.target.value;
  await refreshAll();
});

// Manual refresh button
$("refresh-btn").addEventListener("click", async () => {
  const btn = $("refresh-btn");
  btn.textContent = "↻ …";
  btn.disabled = true;
  await refreshAll();
  btn.textContent = "↻ Actualizar";
  btn.disabled = false;
});

// Day selector buttons
$("day-selector").addEventListener("click", async (e) => {
  if (!e.target.matches(".day-btn")) return;
  document
    .querySelectorAll(".day-btn")
    .forEach((b) => b.classList.remove("active"));
  e.target.classList.add("active");
  currentDays = parseInt(e.target.dataset.days, 10);
  await loadHistory();
});

// ══════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/api/detect");
    const { modelo } = await res.json();
    if (modelo) {
      const sel = $("model-select");
      sel.value = modelo;
      currentModel = modelo;
    }
  } catch (_) { /* si falla, usa el primer modelo de la lista */ }

  await refreshAll();
  startRefresh();
});
