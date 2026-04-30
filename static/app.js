/* ═══════════════════════════════════════════════════════════
   Battery Health Monitor — Frontend Logic
   ══════════════════════════════════════════════════════════ */

"use strict";

// ── Config ────────────────────────────────────────────────
const REFRESH_MS   = 30_000; // Auto-refresh interval
const CIRCUMF      = 552.92; // 2π × 88  (gauge SVG radius)
const RT_MAX_PTS   = 120;    // Máx. puntos en tiempo real (~1 h a 30 s)

// ── State ─────────────────────────────────────────────────
let chart         = null;
let refreshTimer  = null;
let currentModel  = document.getElementById("model-select").value;
let sessionStart  = null;
const rtBuffer    = []; // buffer de lecturas de la sesión actual

// ── DOM helpers ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (id) => document.getElementById(id);

// ── Count-up animation ────────────────────────────────────
function animateNumber(el, toValue, suffix = "", decimals = 1) {
  const from = parseFloat(el.dataset.rawValue ?? toValue) || 0;
  el.dataset.rawValue = toValue;

  if (Math.abs(from - toValue) < 0.05) {
    el.textContent = toValue.toFixed(decimals) + suffix;
    return;
  }

  // Pop animation on metric-value elements
  if (el.classList.contains("metric-value")) {
    el.classList.remove("value-pop");
    void el.offsetWidth; // force reflow
    el.classList.add("value-pop");
    el.addEventListener("animationend", () => el.classList.remove("value-pop"), { once: true });
  }

  const duration = 700;
  const start = performance.now();

  function tick(now) {
    const t      = Math.min((now - start) / duration, 1);
    const eased  = 1 - Math.pow(1 - t, 3);
    const current = from + (toValue - from) * eased;
    el.textContent = current.toFixed(decimals) + suffix;
    if (t < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ── Health color ──────────────────────────────────────────
function healthColor(pct) {
  if (pct === null || pct === undefined) return "#274060";
  if (pct >= 90) return "#00e676";
  if (pct >= 80) return "#69f0ae";
  if (pct >= 70) return "#ffd740";
  if (pct >= 60) return "#ff9100";
  return "#ff5252";
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
    pushRealtime(data);
    renderChart();
    updateChartSubtitle();
  } catch (err) {
    showError("No se pudo conectar con el servidor. ¿Está corriendo app.py?");
    setStatus("error");
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

    // Sync outer glow arc
    const arcGlow = $("gauge-arc-glow");
    if (arcGlow) {
      arcGlow.style.strokeDashoffset = offset;
      arcGlow.style.stroke = healthColor(pct);
    }

    animateNumber($("gauge-pct"), pct, "%", 1);
    $("gauge-label").textContent = data.health_label || "—";
    $("gauge-label").style.color = healthColor(pct);

    const mah = data.full_mah_est
      ? Math.round(data.full_mah_est)
      : (data.current_mah ?? null);
    $("gauge-mah").textContent = mah !== null ? `${mah} mAh` : "— mAh";
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
  // Level — count-up + gradient bar
  const lvl = data.level ?? 0;
  animateNumber($("m-level"), lvl, "%", 0);
  const barFill = $("level-bar-fill");
  barFill.style.width = `${lvl}%`;
  if (lvl > 50) {
    barFill.style.background  = "linear-gradient(90deg, #0099cc, #00ccff)";
    barFill.style.boxShadow   = "0 0 8px rgba(0, 204, 255, 0.65)";
  } else if (lvl > 20) {
    barFill.style.background  = "linear-gradient(90deg, #cc8800, #ffd740)";
    barFill.style.boxShadow   = "0 0 8px rgba(255, 215, 64, 0.5)";
  } else {
    barFill.style.background  = "linear-gradient(90deg, #aa2200, #ff5252)";
    barFill.style.boxShadow   = "0 0 8px rgba(255, 82, 82, 0.55)";
  }

  // Status
  $("m-status").textContent = data.status_name ?? "—";

  // Temperature — count-up
  const temp = data.temp_c;
  if (temp !== null && temp !== undefined) {
    animateNumber($("m-temp"), temp, " °C", 1);
  } else {
    $("m-temp").textContent = "—";
  }
  const mc = $("mc-temp");
  mc.classList.remove("warm", "hot");
  if (temp > 40) mc.classList.add("hot");
  else if (temp > 32) mc.classList.add("warm");

  // Voltage — count-up
  if (data.voltage_mv) {
    animateNumber($("m-voltage"), data.voltage_mv, " mV", 0);
  } else {
    $("m-voltage").textContent = "—";
  }

  // Charge counter → show as current mAh — count-up
  const mah =
    data.current_mah ??
    (data.charge_counter ? Math.round(data.charge_counter / 1000) : null);
  if (mah !== null) {
    animateNumber($("m-counter"), mah, " mAh", 0);
  } else {
    $("m-counter").textContent = "—";
  }

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
//  REALTIME BUFFER
// ══════════════════════════════════════════════════════════

function pushRealtime(data) {
  if (!sessionStart) sessionStart = new Date();
  const now = new Date();
  rtBuffer.push({
    time: now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    health_pct: data.health_pct,
    level: data.level,
  });
  if (rtBuffer.length > RT_MAX_PTS) rtBuffer.shift();
}

// ══════════════════════════════════════════════════════════
//  CHART — tiempo real
// ══════════════════════════════════════════════════════════

function renderChart() {
  const canvas = $("health-chart");
  const empty  = $("chart-empty");

  if (rtBuffer.length === 0) {
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  canvas.classList.remove("hidden");
  empty.classList.add("hidden");

  const labels     = rtBuffer.map((r) => r.time);
  const healthData = rtBuffer.map((r) => r.health_pct);
  const levelData  = rtBuffer.map((r) => r.level);

  const ctx = canvas.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, "rgba(0, 204, 255, 0.30)");
  grad.addColorStop(1, "rgba(0, 204, 255, 0.0)");

  const gradLevel = ctx.createLinearGradient(0, 0, 0, 260);
  gradLevel.addColorStop(0, "rgba(0, 230, 118, 0.15)");
  gradLevel.addColorStop(1, "rgba(0, 230, 118, 0.0)");

  const pr = rtBuffer.length < 12 ? 4 : 2;

  const datasets = [
    {
      label: "Salud (%)",
      data: healthData,
      borderColor: "#00ccff",
      backgroundColor: grad,
      borderWidth: 2.5,
      pointRadius: pr,
      pointBackgroundColor: "#00ccff",
      pointBorderColor: "#071525",
      pointBorderWidth: 2,
      tension: 0.35,
      fill: true,
    },
    {
      label: "Carga (%)",
      data: levelData,
      borderColor: "#00e676",
      backgroundColor: gradLevel,
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.35,
      fill: true,
      borderDash: [4, 4],
    },
  ];

  if (chart) {
    chart.data.labels        = labels;
    chart.data.datasets      = datasets;
    chart.options.scales.y.min = _yMin(healthData, levelData);
    chart.update("active");
    return;
  }

  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            color: "#5f8fad",
            font: { family: "Inter", size: 12 },
            usePointStyle: true,
            pointStyleWidth: 10,
          },
        },
        tooltip: {
          backgroundColor: "rgba(5, 16, 30, 0.92)",
          borderColor: "rgba(0, 204, 255, 0.2)",
          borderWidth: 1,
          titleColor: "#eaf4ff",
          bodyColor: "#5f8fad",
          padding: 14,
          cornerRadius: 10,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 4,
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? "—"}%`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(15, 37, 64, 0.8)", drawBorder: false },
          ticks: {
            color: "#274060",
            font: { family: "Inter", size: 11 },
            maxTicksLimit: 8,
          },
          border: { display: false },
        },
        y: {
          min: _yMin(healthData, levelData),
          max: 102,
          grid: { color: "rgba(15, 37, 64, 0.8)", drawBorder: false },
          ticks: {
            color: "#274060",
            font: { family: "Inter", size: 11 },
            callback: (v) => v + "%",
          },
          border: { display: false },
        },
      },
    },
  });
}

function _yMin(healthData, levelData) {
  const all = [...healthData, ...levelData].filter((v) => v !== null && v !== undefined);
  return all.length ? Math.max(0, Math.min(...all) - 5) : 0;
}

function updateChartSubtitle() {
  const sub = $("chart-subtitle");
  if (!sessionStart || rtBuffer.length === 0) {
    sub.textContent = "Esperando primera lectura…";
    return;
  }
  const n       = rtBuffer.length;
  const mins    = Math.floor((Date.now() - sessionStart.getTime()) / 60000);
  const inicio  = sessionStart.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  const durStr  = mins > 0 ? `${mins} min · ` : "";
  sub.textContent = `${n} lectura${n !== 1 ? "s" : ""} · ${durStr}desde las ${inicio}`;
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
  btn.classList.add("loading");
  btn.disabled = true;
  await refreshAll();
  btn.classList.remove("loading");
  btn.disabled = false;
});

// ══════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const res = await fetch("/api/detect");
    const { modelo, brand, raw_model, is_samsung } = await res.json();
    if (modelo) {
      const sel = $("model-select");
      sel.value = modelo;
      currentModel = modelo;
    }
    const chip = $("device-chip");
    const sel  = $("model-select");
    if (!is_samsung) {
      const label = brand
        ? (raw_model ? `📱 ${brand} ${raw_model}` : `📱 ${brand}`)
        : "📱 Otro";
      chip.textContent = label;
      chip.classList.remove("hidden");
      sel.classList.add("hidden");
    }
  } catch (_) { /* si falla, usa el primer modelo de la lista */ }

  await refreshAll();
  startRefresh();
});
