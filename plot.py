#!/usr/bin/env -S uv run --script
"""
WiFi Performance Plotting Script

This script reads WiFi performance data from a CSV file and creates a comparison plot
showing throughput ranges, average speeds, and signal strength for different routers.

Usage:
    uv run plot.py

Data Format:
    Expected CSV format: {FILENAME_PREFIX}.csv
    Columns:
        Spot        - Measurement location (e.g., "Kitchen (1F)", "Office (B)")
        Router      - Router model being tested (e.g., "Bell Giga", "UniFi U6-LR Wall")
        Client      - Device used for testing (e.g., "Ipad Air 4", "Pixel 6")
        Signal dBm  - WiFi signal strength in decibels milliwatt (e.g., -32, -75)
        Down ↓Mbps  - Download speed in megabits per second
        Up ↑ Mbps   - Upload speed in megabits per second

Dependencies are automatically managed via PEP 723 inline script metadata below.
The script can also be run directly as ./plot.py after chmod +x plot.py
"""

# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "pandas",
#     "matplotlib",
#     "numpy",
# ]
# ///

import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# File naming constant
FILENAME_PREFIX = "UniFi-WiFi-Placement-2025-06-24"


def main():
    """Main function to run the WiFi performance analysis and plotting."""
    df = load_and_clean_data()
    data_validation(df)
    make_plot(df)


def load_and_clean_data():
    """Load CSV data and clean column names."""
    csv_filename = f"{FILENAME_PREFIX}.csv"
    df = pd.read_csv(csv_filename)
    print(f"✓ Read data from: {csv_filename}")
    # Clean column names (remove special characters)
    df.columns = ["Spot", "Router", "Client", "Signal_dBm", "Down_Mbps", "Up_Mbps"]
    return df


def data_validation(df):
    """Validate data quality and completeness."""
    print(f"  ✓ Dataset contains {len(df)} measurements")

    # Discover all unique values from the data
    all_spots = sorted(df["Spot"].unique())
    all_routers = sorted(df["Router"].unique())
    all_clients = sorted(df["Client"].unique())

    print(f"  ✓ Unique spots: {all_spots}")
    print(f"  ✓ Unique routers: {all_routers}")
    print(f"  ✓ Unique clients: {all_clients}")

    # Signal_dBm should all be negative (stronger signal = closer to 0)
    signal_min, signal_max = df["Signal_dBm"].min(), df["Signal_dBm"].max()
    print(f"  ✓ Signal strength range: {signal_min} to {signal_max} dBm")
    assert signal_max <= 0, (
        f"Found positive signal strength: {signal_max} dBm (should be negative)"
    )
    assert signal_min >= -100, (
        f"Signal too weak: {signal_min} dBm (suspicious, check data)"
    )

    # Download and Upload speeds should be positive
    down_min, down_max = df["Down_Mbps"].min(), df["Down_Mbps"].max()
    up_min, up_max = df["Up_Mbps"].min(), df["Up_Mbps"].max()
    print(f"  ✓ Download speed range: {down_min} to {down_max} Mbps")
    print(f"  ✓ Upload speed range: {up_min} to {up_max} Mbps")
    assert down_min > 0, f"Found non-positive download speed: {down_min} Mbps"
    assert up_min > 0, f"Found non-positive upload speed: {up_min} Mbps"

    # Validate completeness: each router/client pair should have data for each spot
    expected_combinations = len(all_spots) * len(all_routers) * len(all_clients)
    print(
        f"  ✓ Expected combinations (spots × routers × clients): {expected_combinations}"
    )

    for router in all_routers:
        for client in all_clients:
            for spot in all_spots:
                subset = df[
                    (df["Router"] == router)
                    & (df["Client"] == client)
                    & (df["Spot"] == spot)
                ]
                if subset.empty:
                    raise ValueError(
                        f"Missing data for Router='{router}', Client='{client}', Spot='{spot}'"
                    )

    print("  ✓ Data validation passed!")
    print("  ✓ Complete data validation passed!")


def make_plot(df):
    """Create the WiFi performance comparison plot."""
    # Group by router and spot to calculate statistics
    grouped = (
        df.groupby(["Router", "Spot"])
        .apply(calculate_stats, include_groups=False)
        .reset_index()
    )

    # Separate router data
    routers = sorted(df["Router"].unique())
    router_data = {}
    for router in routers:
        router_data[router] = grouped[grouped["Router"] == router].copy()

    # Define spot order based on average download speed - slowest to fastest
    # Fixed order ensures all routers' data aligns at same x-positions for proper comparison
    spot_down_avg = df.groupby("Spot")["Down_Mbps"].mean().sort_values()
    spot_order = spot_down_avg.index.tolist()

    print("✓ Spots ordered by average download speed (slowest to fastest)")
    x_positions = np.arange(len(spot_order))

    # Prepare data for each router
    plot_data = {}
    for i, router in enumerate(routers):
        # All routers use same x-positions - colors/styles distinguish them
        x_pos = x_positions

        # Reorder data to match spot_order
        reordered = []
        for spot in spot_order:
            router_spot = router_data[router][router_data[router]["Spot"] == spot]
            reordered.append(router_spot.iloc[0])

        data = pd.DataFrame(reordered)

        plot_data[router] = {"x": x_pos, "data": data}

    # Create the plot
    fig, ax1 = plt.subplots(figsize=(12, 6))

    # Colors for each router
    colors = ["orange", "blue", "green", "red", "purple"]

    for i, router in enumerate(routers):
        x = plot_data[router]["x"]
        data = plot_data[router]["data"]
        color = colors[i % len(colors)]

        # Calculate overall throughput ranges
        min_overall = np.minimum(
            np.array(data["Down_min"], dtype=np.float64),
            np.array(data["Up_min"], dtype=np.float64),
        )
        max_overall = np.maximum(
            np.array(data["Down_max"], dtype=np.float64),
            np.array(data["Up_max"], dtype=np.float64),
        )

        # Extract plotting data
        up_mean = np.array(data["Up_mean"], dtype=np.float64)
        down_mean = np.array(data["Down_mean"], dtype=np.float64)
        rssi_mean = np.array(data["RSSI_mean"], dtype=np.float64)

        # Fill shaded throughput ranges
        ax1.fill_between(
            x,
            min_overall,
            max_overall,
            color=color,
            alpha=0.2,
            label=f"{router} Range",
        )

        # Average up/down lines
        ax1.plot(x, up_mean, color=color, linestyle="--", label=f"{router} Avg Up")
        ax1.plot(x, down_mean, color=color, linestyle="-.", label=f"{router} Avg Down")

    ax1.set_ylabel("Throughput (Mbps)")
    ax1.set_xlabel("Measurement Spot")
    ax1.set_xticks(x_positions)
    ax1.set_xticklabels(spot_order, rotation=45, ha="right")

    # RSSI on secondary axis
    ax2 = ax1.twinx()
    for i, router in enumerate(routers):
        x = plot_data[router]["x"]
        data = plot_data[router]["data"]
        color = colors[i % len(colors)]
        rssi_mean = np.array(data["RSSI_mean"], dtype=np.float64)
        ax2.plot(x, rssi_mean, "o--", color=color, label=f"{router} Avg RSSI")

    ax2.set_ylabel("Signal Strength (dBm)")
    ax2.set_ylim(-90, -20)

    # Combined legend
    lines_1, labels_1 = ax1.get_legend_handles_labels()
    lines_2, labels_2 = ax2.get_legend_handles_labels()
    ax1.legend(lines_1 + lines_2, labels_1 + labels_2, loc="upper left", fontsize=10)

    plt.title("WiFi Performance and Signal Strength by Spot")
    plt.tight_layout()

    # Save as PNG file
    png_filename = f"{FILENAME_PREFIX}.png"
    plt.savefig(png_filename, dpi=300, bbox_inches="tight")
    print(f"✓ Plot saved as: {png_filename}")

    plt.show()


def calculate_stats(group):
    """Calculate summary statistics for a group of measurements at the same location+router combination."""
    return pd.Series(
        {
            "Down_min": group["Down_Mbps"].min(),
            "Down_max": group["Down_Mbps"].max(),
            "Down_mean": group["Down_Mbps"].mean(),
            "Up_min": group["Up_Mbps"].min(),
            "Up_max": group["Up_Mbps"].max(),
            "Up_mean": group["Up_Mbps"].mean(),
            "RSSI_mean": group["Signal_dBm"].mean(),
        }
    )


if __name__ == "__main__":
    main()
