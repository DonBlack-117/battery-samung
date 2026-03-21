#!/usr/bin/env python3
"""
Script para revisar la salud real de la batería en dispositivos Samsung.
Requiere: ADB instalado y USB Debugging activado en el teléfono.

Uso:
  python bateria.py                        # Lectura única
  python bateria.py --watch 5              # Actualizar cada 5 segundos
  python bateria.py --json                 # Salida en formato JSON
  python bateria.py --modelo "S23 Ultra"   # Especificar modelo Samsung
  python bateria.py --lista-modelos        # Ver modelos disponibles
"""

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

# Usa adb.exe local en adb/ si existe; si no, busca en el PATH del sistema
_ADB_LOCAL = Path(__file__).parent / "adb" / "adb.exe"
_ADB_CMD = str(_ADB_LOCAL) if _ADB_LOCAL.exists() else "adb"

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table
    from rich import box

    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False

# ── Capacidades de fábrica por modelo (mAh) ──────────────────────────────────
SAMSUNG_CAPACITIES = {
    # Serie S25
    "S25 Ultra": 5000,
    "S25+": 4900,
    "S25": 4000,
    # Serie S24
    "S24 Ultra": 5000,
    "S24+": 4900,
    "S24": 4000,
    # Serie S23
    "S23 Ultra": 5000,
    "S23+": 4700,
    "S23": 3900,
    # Serie S22
    "S22 Ultra": 5000,
    "S22+": 4500,
    "S22": 3700,
    # Serie S21
    "S21 Ultra": 5000,
    "S21+": 4800,
    "S21": 4000,
    # Serie S20
    "S20 Ultra": 5000,
    "S20+": 4500,
    "S20": 4000,
    # Note
    "Note 20 Ultra": 4500,
    "Note 20": 4300,
    # Serie A (alta gama)
    "A73": 5000,
    "A55": 5000,
    "A54": 5000,
    "A53": 5000,
    # Serie A (gama media)
    "A35": 5000,
    "A34": 5000,
    "A33": 5000,
    "A25": 5000,
    # Serie A (gama baja)
    "A15": 5000,
    "A14": 5000,
    "A13": 5000,
    "A05s": 5000,
    "A05": 5000,
}

# ── Mapa de códigos ADB → nombre de modelo ────────────────────────────────────
# Clave: primeros 7 caracteres de ro.product.model (ej. "SM-A057")
DEVICE_CODE_MAP = {
    # S25
    "SM-S938": "S25 Ultra",
    "SM-S936": "S25+",
    "SM-S931": "S25",
    # S24
    "SM-S928": "S24 Ultra",
    "SM-S926": "S24+",
    "SM-S921": "S24",
    # S23
    "SM-S918": "S23 Ultra",
    "SM-S916": "S23+",
    "SM-S911": "S23",
    # S22
    "SM-S908": "S22 Ultra",
    "SM-S906": "S22+",
    "SM-S901": "S22",
    # S21
    "SM-G998": "S21 Ultra",
    "SM-G996": "S21+",
    "SM-G991": "S21",
    # S20
    "SM-G988": "S20 Ultra",
    "SM-G986": "S20+",
    "SM-G981": "S20",
    # Note 20
    "SM-N986": "Note 20 Ultra",
    "SM-N981": "Note 20",
    # A series
    "SM-A736": "A73",
    "SM-A556": "A55",
    "SM-A546": "A54",
    "SM-A536": "A53",
    "SM-A356": "A35",
    "SM-A346": "A34",
    "SM-A336": "A33",
    "SM-A256": "A25",
    "SM-A156": "A15",
    "SM-A155": "A15",
    "SM-A146": "A14",
    "SM-A135": "A13",
    "SM-A057": "A05s",
    "SM-A055": "A05",
}

HEALTH_LABELS = [
    (90, "Excelente", "green"),
    (80, "Muy bueno", "green"),
    (70, "Bueno", "yellow"),
    (60, "Regular — considera revisarla", "yellow"),
    (0, "Deficiente — considera reemplazarla", "red"),
]

HEALTH_NAMES = {
    1: "Desconocido",
    2: "Bueno",
    3: "Sobrecalentamiento",
    4: "Muerta",
    5: "Sobrevoltaje",
    6: "Fallo",
    7: "Fría",
}

STATUS_NAMES = {
    1: "Desconocido",
    2: "Cargando",
    3: "Descargando",
    4: "Sin cargar (llena)",
    5: "Completa",
}

console = Console() if RICH_AVAILABLE else None


# ── Utilidades ────────────────────────────────────────────────────────────────


def safe_int(value, default=0) -> int:
    """Convierte a int de forma segura; retorna default si falla."""
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def run_adb(command: list) -> tuple[str, int]:
    try:
        result = subprocess.run(
            [_ADB_CMD] + command,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.stdout.strip(), result.returncode
    except FileNotFoundError:
        _print_error(
            "ADB no está instalado o no está en el PATH.\n"
            "Descárgalo en: https://developer.android.com/studio/releases/platform-tools"
        )
        sys.exit(1)
    except subprocess.TimeoutExpired:
        return "", 1


def _print_error(msg: str):
    if RICH_AVAILABLE:
        console.print(f"[bold red]❌ {msg}[/bold red]")
    else:
        print(f"❌ {msg}")


def get_health_info(pct: float) -> tuple[str, str]:
    """Retorna (etiqueta, color) según el porcentaje de salud."""
    for threshold, label, color in HEALTH_LABELS:
        if pct >= threshold:
            return label, color
    return HEALTH_LABELS[-1][1], HEALTH_LABELS[-1][2]


# ── Lectura de datos ──────────────────────────────────────────────────────────


def detect_device_model() -> str | None:
    """Detecta automáticamente el modelo Samsung del dispositivo conectado.
    Retorna el nombre del modelo (clave de SAMSUNG_CAPACITIES) o None si no se reconoce."""
    # Intento 1: nombre de marketing (ej. "Galaxy A05s")
    marketname, code = run_adb(["shell", "getprop", "ro.product.marketname"])
    if code == 0 and marketname:
        name = re.sub(r"^(Samsung\s+)?Galaxy\s+", "", marketname.strip(), flags=re.IGNORECASE)
        if name in SAMSUNG_CAPACITIES:
            return name

    # Intento 2: código de modelo (ej. "SM-A057F") → primeros 7 chars
    model_code, code = run_adb(["shell", "getprop", "ro.product.model"])
    if code == 0 and model_code:
        prefix = model_code.strip()[:7].upper()
        if prefix in DEVICE_CODE_MAP:
            return DEVICE_CODE_MAP[prefix]

    return None


def check_device():
    output, _ = run_adb(["devices"])
    lines = [l for l in output.splitlines() if l.endswith("device")]
    if not lines:
        _print_error("No se detectó ningún dispositivo.")
        print("   Asegúrate de:")
        print("   1. Conectar el teléfono por USB")
        print("   2. Tener activado 'Depuración USB' en Opciones para desarrolladores")
        print("   3. Tocar 'Permitir' en el aviso del teléfono")
        sys.exit(1)


def read_sys_value(path: str) -> int | None:
    out, code = run_adb(["shell", f"cat {path} 2>/dev/null"])
    if code == 0 and out.lstrip("-").isdigit():
        return int(out)
    return None


def parse_dumpsys_battery(text: str) -> dict:
    """Extrae los campos principales del dumpsys battery."""
    data = {}
    for line in text.splitlines():
        line = line.strip()
        if ":" in line and not line.startswith("02-") and "ACTION_BATTERY" not in line:
            key, _, val = line.partition(":")
            data[key.strip().lower()] = val.strip()
    return data


def get_battery_data() -> dict:
    """Lee todos los datos crudos del dispositivo vía ADB."""
    # Método 1: sysfs
    charge_full = read_sys_value("/sys/class/power_supply/battery/charge_full")
    charge_full_design = read_sys_value(
        "/sys/class/power_supply/battery/charge_full_design"
    )

    if charge_full is None:
        charge_full = read_sys_value(
            "/sys/class/power_supply/battery/batt_capacity_max"
        )
    if charge_full is None:
        charge_full = read_sys_value("/sys/class/power_supply/battery/fg_capacity")

    # Método 2: dumpsys battery
    dumpsys_out, _ = run_adb(["shell", "dumpsys", "battery"])
    batt = parse_dumpsys_battery(dumpsys_out)

    return {
        "charge_full": charge_full,
        "charge_full_design": charge_full_design,
        "level": safe_int(batt.get("level"), 0),
        "charge_counter": safe_int(batt.get("charge counter"), 0),  # µAh
        "voltage_mv": safe_int(batt.get("voltage"), 0),  # mV
        "temperature_raw": safe_int(batt.get("temperature"), 0),  # décimas °C
        "health_code": safe_int(batt.get("health"), 2),
        "status_code": safe_int(batt.get("status"), 0),
    }


# ── Cálculo de salud ──────────────────────────────────────────────────────────


def calculate_health(data: dict, design_capacity_mah: int) -> dict:
    """Calcula el porcentaje de salud y capacidad estimada."""
    charge_full = data["charge_full"]
    charge_full_design = data["charge_full_design"]
    charge_counter = data["charge_counter"]
    level = data["level"]

    health_pct = None
    method_used = None
    current_mah = None
    full_mah_est = None

    if charge_full and charge_full_design and charge_full_design > 0:
        health_pct = round((charge_full / charge_full_design) * 100, 1)
        current_mah = round(charge_full / 1000)
        method_used = "sysfs (lectura directa)"

    elif charge_counter and charge_counter > 100_000 and level and level > 5:
        full_mah_est = round((charge_counter / level) * 100 / 1000, 0)
        health_pct = round((full_mah_est / design_capacity_mah) * 100, 1)
        current_mah = round(charge_counter / 1000)
        method_used = (
            f"estimación (charge_counter={charge_counter} µAh, nivel={level}%)"
        )

    # Detección de protección de batería Samsung
    protect_note = None
    status_code = data["status_code"]
    if level in range(79, 86) and status_code in (4, 5):
        protect_note = (
            f"La carga se detuvo en {level}% — tienes activada la función\n"
            "'Proteger batería' (Ajustes > Batería). Esto es normal y\n"
            "es bueno para la vida útil a largo plazo de la batería."
        )
    elif level in range(79, 86) and status_code == 3:
        protect_note = (
            f"Nota: si la última carga llegó solo al {level}%, puede que\n"
            "tengas 'Proteger batería' activada."
        )

    return {
        "health_pct": health_pct,
        "method_used": method_used,
        "current_mah": current_mah,
        "full_mah_est": full_mah_est,
        "protect_note": protect_note,
        "design_mah": design_capacity_mah,
        "temp_c": round(data["temperature_raw"] / 10, 1),
        "voltage_mv": data["voltage_mv"],
        "level": data["level"],
        "charge_counter": data["charge_counter"],
        "health_code": data["health_code"],
        "status_code": data["status_code"],
        "health_name": HEALTH_NAMES.get(data["health_code"], str(data["health_code"])),
        "status_name": STATUS_NAMES.get(data["status_code"], str(data["status_code"])),
    }


# ── Presentación ──────────────────────────────────────────────────────────────


def display_results(results: dict, modelo: str):
    """Muestra los resultados en consola, con rich si está disponible."""
    if RICH_AVAILABLE:
        _display_rich(results, modelo)
    else:
        _display_plain(results, modelo)


def _display_rich(r: dict, modelo: str):
    health_pct = r["health_pct"]

    # ── Panel de salud principal ──
    if health_pct is not None:
        label, color = get_health_info(health_pct)
        bar_filled = int(health_pct / 5)
        bar = "█" * bar_filled + "░" * (20 - bar_filled)
        health_line = f"[{color}]{health_pct}%  [{bar}]  {label}[/{color}]"

        cap_line = ""
        if r["full_mah_est"]:
            cap_line = f"Capacidad estimada: [bold]{int(r['full_mah_est'])} mAh[/bold]"
        elif r["current_mah"]:
            cap_line = f"Capacidad actual:   [bold]{r['current_mah']} mAh[/bold]"

        body = (
            f"[bold]Salud:[/bold]            {health_line}\n"
            f"{cap_line}\n"
            f"[bold]Capacidad fábrica:[/bold] {r['design_mah']} mAh\n"
            f"[bold]Método:[/bold]            [dim]{r['method_used']}[/dim]"
        )
    else:
        body = (
            "[yellow]⚠️  No se pudo calcular la salud de forma automática.[/yellow]\n"
            "Datos insuficientes (charge_counter=0 o nivel muy bajo).\n"
            "[dim]Tip: carga el teléfono a más del 20% e inténtalo de nuevo.[/dim]"
        )

    console.print()
    console.print(
        Panel(
            body,
            title=f"🔋 Salud de Batería — Samsung Galaxy {modelo}",
            border_style="blue",
            box=box.ROUNDED,
        )
    )

    # ── Tabla de datos en tiempo real ──
    table = Table(box=box.SIMPLE, show_header=False, padding=(0, 2))
    table.add_column("Campo", style="dim")
    table.add_column("Valor", style="bold")

    table.add_row("Nivel de carga", f"{r['level']}%")
    table.add_row("Estado", r["status_name"])
    table.add_row("Salud Android", r["health_name"])
    table.add_row("Temperatura", f"{r['temp_c']} °C")
    table.add_row("Voltaje", f"{r['voltage_mv']} mV")
    table.add_row(
        "Charge counter",
        f"{r['charge_counter']} µAh  ({round(r['charge_counter']/1000)} mAh actuales)",
    )

    console.print(
        Panel(
            table,
            title="ℹ️  Información en tiempo real",
            border_style="dim",
            box=box.ROUNDED,
        )
    )

    if r["protect_note"]:
        console.print(Panel(r["protect_note"], border_style="yellow", box=box.ROUNDED))

    console.print(
        Panel(
            "≥90% Excelente  |  ≥80% Muy bueno  |  ≥70% Bueno  |  ≥60% Regular  |  <60% Deficiente\n"
            "[dim]Samsung considera salud aceptable por encima del 80%.[/dim]",
            title="💡 Referencia",
            border_style="dim",
            box=box.ROUNDED,
        )
    )


def _display_plain(r: dict, modelo: str):
    W = 54
    print()
    print("=" * W)
    print(f"  🔋  SALUD DE BATERÍA — Samsung Galaxy {modelo}")
    print("=" * W)
    print()

    health_pct = r["health_pct"]
    if health_pct is not None:
        label, _ = get_health_info(health_pct)
        bar_filled = int(health_pct / 5)
        bar = "█" * bar_filled + "░" * (20 - bar_filled)
        print(f"  📊  Salud:             {health_pct}%  [{bar}]")
        print(f"       Estado:           {label}")
        if r["full_mah_est"]:
            print(f"  ⚡  Cap. estimada:    {int(r['full_mah_est'])} mAh")
        elif r["current_mah"]:
            print(f"  ⚡  Cap. actual:      {r['current_mah']} mAh")
        print(f"  🏭  Cap. de fábrica:  {r['design_mah']} mAh")
        print(f"  📐  Método:           {r['method_used']}")
    else:
        print("  ⚠️  No se pudo calcular la salud de forma automática.")
        print("      Tip: carga el teléfono a más del 20% e inténtalo de nuevo.")

    print()
    print("─" * W)
    print("  ℹ️  Información en tiempo real:")
    print(f"  🔋  Nivel de carga:  {r['level']}%")
    print(f"  ⚙️  Estado:          {r['status_name']}")
    print(f"  💚  Salud Android:   {r['health_name']}")
    print(f"  🌡️  Temperatura:     {r['temp_c']} °C")
    print(f"  ⚡  Voltaje:         {r['voltage_mv']} mV")
    print(
        f"  🔌  Charge counter:  {r['charge_counter']} µAh ({round(r['charge_counter']/1000)} mAh actuales)"
    )

    if r["protect_note"]:
        print()
        print(f"  ℹ️  {r['protect_note']}")

    print()
    print("=" * W)
    print("  💡  ≥90% Excelente | ≥80% Bueno | ≥70% Regular | <60% Deficiente")
    print("      Samsung considera salud aceptable por encima del 80%.")
    print("=" * W)
    print()


def display_json(results: dict, modelo: str):
    """Imprime los resultados como JSON."""
    out = {
        "modelo": f"Samsung Galaxy {modelo}",
        "health_pct": results["health_pct"],
        "health_label": (
            get_health_info(results["health_pct"])[0] if results["health_pct"] else None
        ),
        "method": results["method_used"],
        "capacity": {
            "current_mah": results["current_mah"],
            "estimated_mah": (
                int(results["full_mah_est"]) if results["full_mah_est"] else None
            ),
            "design_mah": results["design_mah"],
        },
        "realtime": {
            "level_pct": results["level"],
            "status": results["status_name"],
            "android_health": results["health_name"],
            "temperature_c": results["temp_c"],
            "voltage_mv": results["voltage_mv"],
            "charge_counter_uah": results["charge_counter"],
        },
        "protect_battery_detected": results["protect_note"] is not None,
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


# ── Entrada principal ─────────────────────────────────────────────────────────


def parse_args():
    parser = argparse.ArgumentParser(
        description="Monitor de salud de batería para dispositivos Samsung.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--modelo",
        "-m",
        default="S24 Ultra",
        metavar="MODELO",
        help='Modelo Samsung (default: "S24 Ultra"). Usa --lista-modelos para ver todos.',
    )
    parser.add_argument(
        "--watch",
        "-w",
        type=int,
        metavar="SEGS",
        help="Modo continuo: actualizar cada N segundos.",
    )
    parser.add_argument(
        "--json",
        "-j",
        action="store_true",
        help="Salida en formato JSON (útil para integración con otros scripts).",
    )
    parser.add_argument(
        "--lista-modelos",
        action="store_true",
        help="Muestra los modelos Samsung disponibles y sus capacidades.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if args.lista_modelos:
        print("\nModelos Samsung disponibles:\n")
        for modelo, mah in SAMSUNG_CAPACITIES.items():
            print(f"  {modelo:<12}  {mah} mAh")
        print()
        return

    modelo = args.modelo
    design_mah = SAMSUNG_CAPACITIES.get(modelo)
    if design_mah is None:
        print(
            f"⚠️  Modelo '{modelo}' no reconocido. Usa --lista-modelos para ver opciones."
        )
        print(
            "   Si conoces la capacidad, puedes añadirlo al diccionario SAMSUNG_CAPACITIES."
        )
        sys.exit(1)

    check_device()

    def run_once():
        data = get_battery_data()
        results = calculate_health(data, design_mah)
        if args.json:
            display_json(results, modelo)
        else:
            display_results(results, modelo)

    if args.watch:
        try:
            while True:
                if RICH_AVAILABLE:
                    console.clear()
                else:
                    print("\033[2J\033[H", end="")
                run_once()
                if not args.json:
                    msg = f"  Actualizando cada {args.watch}s — Ctrl+C para salir"
                    (
                        print(msg)
                        if not RICH_AVAILABLE
                        else console.print(f"[dim]{msg}[/dim]")
                    )
                time.sleep(args.watch)
        except KeyboardInterrupt:
            print("\nMonitoreo detenido.")
    else:
        run_once()


if __name__ == "__main__":
    main()
