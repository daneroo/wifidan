# Python Visualization

Interactive matplotlib-based analysis with comprehensive data validation and statistical visualization.

## Features

- Throughput range visualization (min/max across all measurements)
- Average download/upload trend lines
- Signal strength correlation analysis
- Data validation and completeness checking
- High-resolution PNG export

## Input

- `../data/UniFi-WiFi-Placement-2025-06-24.csv` - measurement data in CSV

## Usage

```bash
# cd python-viz (this directory )
uv run plot.py
```

## Output

- Interactive matplotlib window for exploration
- `FILENAME_PREFIX = "UniFi-WiFi-Placement-2025-06-24"`
  - `../data/UniFi-WiFi-Placement-2025-06-24.png` - High-resolution plot export
