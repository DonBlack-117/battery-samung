"""
Persistencia SQLite para el historial de lecturas de batería.
"""

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path(__file__).parent / "data" / "battery_data.db"


def init_db():
    DB_PATH.parent.mkdir(exist_ok=True)   # crea data/ si no existe
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS readings (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp       TEXT    NOT NULL,
                modelo          TEXT    NOT NULL,
                health_pct      REAL,
                level           INTEGER,
                voltage_mv      INTEGER,
                temp_c          REAL,
                charge_counter  INTEGER,
                current_mah     INTEGER,
                full_mah_est    REAL,
                method          TEXT
            )
        """)
        conn.commit()


def save_reading(data: dict):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO readings
                (timestamp, modelo, health_pct, level, voltage_mv, temp_c,
                 charge_counter, current_mah, full_mah_est, method)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now().isoformat(),
                data.get("modelo", "S24 Ultra"),
                data.get("health_pct"),
                data.get("level"),
                data.get("voltage_mv"),
                data.get("temp_c"),
                data.get("charge_counter"),
                data.get("current_mah"),
                float(data["full_mah_est"]) if data.get("full_mah_est") else None,
                data.get("method_used"),
            ),
        )
        conn.commit()


def get_readings(days: int = 30, modelo: str = None) -> list[dict]:
    since = (datetime.now() - timedelta(days=days)).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        if modelo:
            rows = conn.execute(
                "SELECT * FROM readings WHERE timestamp > ? AND modelo = ? ORDER BY timestamp ASC",
                (since, modelo),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM readings WHERE timestamp > ? ORDER BY timestamp ASC",
                (since,),
            ).fetchall()
    return [dict(r) for r in rows]


def get_stats(modelo: str = None) -> dict:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        where = "WHERE modelo = ?" if modelo else ""
        params = (modelo,) if modelo else ()

        total = conn.execute(
            f"SELECT COUNT(*) AS cnt FROM readings {where}", params
        ).fetchone()
        first = conn.execute(
            f"SELECT health_pct, timestamp FROM readings {where} ORDER BY timestamp ASC LIMIT 1",
            params,
        ).fetchone()
        last = conn.execute(
            f"SELECT health_pct, timestamp FROM readings {where} ORDER BY timestamp DESC LIMIT 1",
            params,
        ).fetchone()
        max_temp = conn.execute(
            f"SELECT MAX(temp_c) AS mt FROM readings {where}", params
        ).fetchone()

    result = {"total_readings": total["cnt"] if total else 0}

    if not first or not last or first["health_pct"] is None or last["health_pct"] is None:
        return result

    t1 = datetime.fromisoformat(first["timestamp"])
    t2 = datetime.fromisoformat(last["timestamp"])
    days_diff = max((t2 - t1).days, 1)
    health_diff = first["health_pct"] - last["health_pct"]
    monthly_degradation = (health_diff / days_diff) * 30

    current_health = last["health_pct"]
    months_to_80 = None
    if monthly_degradation > 0 and current_health > 80:
        months_to_80 = round((current_health - 80) / monthly_degradation, 1)

    result.update(
        {
            "first_date":          t1.strftime("%d/%m/%Y"),
            "first_health":        round(first["health_pct"], 1),
            "last_health":         round(last["health_pct"], 1),
            "monthly_degradation": round(monthly_degradation, 3),
            "months_to_80":        months_to_80,
            "max_temp_c":          round(max_temp["mt"], 1) if max_temp["mt"] else None,
        }
    )
    return result
