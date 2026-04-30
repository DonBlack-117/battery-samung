"""
Servidor Flask para el dashboard de salud de batería.
Uso:  python app.py
Abre automáticamente http://localhost:5000 en el navegador.
"""

import csv
import io
import threading
import webbrowser

from flask import Flask, Response, jsonify, render_template

import database as db
from bateria import (
    ADBNotFoundError,
    SAMSUNG_CAPACITIES,
    analyze_renovation_risk,
    calculate_health,
    detect_device_info,
    get_battery_data,
    get_health_info,
    get_renovation_indicators,
)

app = Flask(__name__)
db.init_db()


# ── Helpers ───────────────────────────────────────────────────────────────────


def _get_current_data(modelo: str = "S24 Ultra") -> tuple[dict | None, str | None]:
    """Obtiene datos actuales del dispositivo. Retorna (data, error)."""
    design_mah = SAMSUNG_CAPACITIES.get(modelo, 5000)
    try:
        raw = get_battery_data()
        results = calculate_health(raw, design_mah)
        results["modelo"] = modelo

        if results["health_pct"] is not None:
            label, color = get_health_info(results["health_pct"])
        else:
            label, color = "Sin datos", "gray"

        results["health_label"] = label
        results["health_color"] = color

        # Normalizar floats para JSON
        for k, v in results.items():
            if hasattr(v, "__float__") and not isinstance(
                v, (int, float, str, bool, type(None))
            ):
                results[k] = float(v)

        return results, None

    except (ADBNotFoundError, RuntimeError) as exc:
        return None, str(exc)
    except Exception as exc:
        return None, str(exc)


# ── Rutas ─────────────────────────────────────────────────────────────────────


@app.route("/")
def index():
    return render_template("index.html", modelos=list(SAMSUNG_CAPACITIES.keys()))


@app.route("/api/current")
@app.route("/api/current/<modelo>")
def api_current(modelo: str = "S24 Ultra"):
    data, error = _get_current_data(modelo)
    if error:
        return jsonify({"error": error}), 503

    # Solo guardar si health_pct tiene valor (evita guardar lecturas vacías)
    if data.get("health_pct") is not None:
        db.save_reading(data)

    return jsonify(data)


@app.route("/api/renovation")
@app.route("/api/renovation/<modelo>")
def api_renovation(modelo: str = "S24 Ultra"):
    data, error = _get_current_data(modelo)
    if error:
        return jsonify({"error": error}), 503
    indicators = get_renovation_indicators()
    report = analyze_renovation_risk(indicators, data.get("health_pct"))
    return jsonify(report)


@app.route("/api/detect")
def api_detect():
    return jsonify(detect_device_info())


@app.route("/api/history")
@app.route("/api/history/<int:days>")
def api_history(days: int = 30):
    readings = db.get_readings(days=days)
    return jsonify(readings)


@app.route("/api/stats")
def api_stats():
    return jsonify(db.get_stats())


@app.route("/api/export/csv")
def api_export_csv():
    readings = db.get_readings(days=365)
    output = io.StringIO()
    fields = [
        "timestamp",
        "modelo",
        "health_pct",
        "level",
        "voltage_mv",
        "temp_c",
        "charge_counter",
        "current_mah",
        "full_mah_est",
        "method",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(readings)
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=battery_history.csv"},
    )


# ── Inicio ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    threading.Timer(1.2, lambda: webbrowser.open("http://localhost:5000")).start()
    print("🔋  Battery Health Monitor — http://localhost:5000")
    print("    Presiona Ctrl+C para detener.\n")
    app.run(debug=False, port=5000)
