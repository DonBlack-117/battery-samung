# Battery-Sam

Real-time battery health monitoring dashboard for Samsung Android devices. Connects to your phone via USB using ADB and provides a web dashboard with live metrics, historical tracking, and degradation analysis.

![Python](https://img.shields.io/badge/Python-3.10+-blue)
![Flask](https://img.shields.io/badge/Flask-3.0+-green)
![Platform](https://img.shields.io/badge/Platform-Windows-lightgrey)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- **Real-time monitoring** — battery level, health %, voltage, temperature, and capacity
- **Historical tracking** — stores readings in SQLite and plots trends over 7d / 30d / 90d / 1 year
- **Degradation analysis** — monthly degradation rate and estimated months until 80% health threshold
- **Samsung model detection** — auto-detects 30+ Galaxy models (S-series, Note, A-series) via ADB; also reports brand and raw model for non-Samsung devices
- **Renovation risk analysis** — detects signs of refurbished devices: cycle count, Knox warranty bit, Knox hardware fuse, battery health vs. claimed condition
- **Battery protection detection** — identifies Samsung's "Protect Battery" feature that caps charge at 85%
- **Temperature alerts** — warns at >35 °C and critical at >40 °C
- **CSV export** — download up to one year of readings for external analysis
- **CLI mode** — rich terminal output for quick checks, watch mode, or renovation report
- **Animated dashboard** — count-up number transitions and a live session chart that builds up in real time (up to 120 data points, ~1 hour at 30 s interval)

## Screenshots

> Dashboard running at `http://localhost:5000`

The web dashboard features a circular health gauge, six real-time metric cards, an interactive Chart.js history graph, and a statistics panel.

## Requirements

- Windows 10/11
- Python 3.10+
- A Samsung Android device with **USB Debugging** enabled
- USB cable

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/battery-sam.git
cd battery-sam
pip install -r requirements.txt
```

ADB binaries are already bundled in the `adb/` directory — no additional Android SDK installation needed.

## Usage

### Web Dashboard

```bash
python app.py
```

Opens automatically at `http://localhost:5000`. The dashboard refreshes every 30 seconds.

### CLI

```bash
# Single reading
python bateria.py

# Watch mode (refresh every 5 seconds)
python bateria.py --watch 5

# JSON output (for scripting)
python bateria.py --json

# Specify model manually
python bateria.py --modelo "S23 Ultra"

# List supported models
python bateria.py --lista-modelos

# Renovation risk report (cycle count, Knox fuse, warranty bit)
python bateria.py --renovado
```

## Supported Samsung Models

S25 series · S24 series · S23 series · S22 series · S21 series · S20 series · Note 20 series · A54 · A53 · A34 · A14 · and more.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Main dashboard |
| GET | `/api/current/<model>` | Current battery data |
| GET | `/api/detect` | Detect connected device — returns `{modelo, brand, raw_model, is_samsung}` |
| GET | `/api/renovation` | Renovation risk report for the connected device |
| GET | `/api/renovation/<model>` | Renovation risk report with explicit model |
| GET | `/api/history/<days>` | Historical readings |
| GET | `/api/stats` | Aggregated statistics |
| GET | `/api/export/csv` | Download CSV export |

## How Battery Health is Calculated

1. **Primary method**: reads `/sys/class/power_supply/battery/charge_full` and `charge_full_design` directly from the device via ADB shell.
2. **Fallback method**: estimates capacity using `charge_counter` and the current battery level percentage.

Health percentage = `(current capacity / design capacity) × 100`

## Project Structure

```
battery-sam/
├── app.py            # Flask server and API routes
├── bateria.py        # Core ADB data collection and analysis
├── database.py       # SQLite read/write helpers
├── requirements.txt
├── adb/              # Bundled ADB binaries (Windows)
├── templates/
│   └── index.html    # Single-page dashboard
└── static/
    ├── app.js        # Dashboard JavaScript
    └── style.css     # Dark theme styles
```

## License

MIT — see [LICENSE](LICENSE) for details.

The ADB binaries bundled in `adb/` are from the Android Open Source Project and are licensed under the Apache 2.0 License (see `adb/notice.txt`).
