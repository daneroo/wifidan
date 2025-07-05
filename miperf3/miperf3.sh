#!/usr/bin/env bash

# This script was installed on my mobile devices using the following command:
# curl -L https://bit.ly/miperf3-inst | sh

# Take iperf3 measurements on mobile devices
# Ish- https://ish.app/
# Temux- https://wiki.termux.com/wiki/Main_Page

# Config
IPERF_TARGET="192.168.2.33"
IPERF_OPTS="-P 4 -O 1"  # 4 streams, 1s warmup
LOCATION="UNSET"
duration=5
verbose=false

# Functions
usage() {
  echo "Usage: $0 [-t <seconds>] [-v] [-h]"
  echo "  -t: duration in seconds (default: 5)"
  echo "  -v: verbose output (prints download/upload speeds as they are measured)"
  echo "  -h: print this help message"
  echo "To update, run:"
  echo "curl -L https://bit.ly/miperf3-inst | sh"
  exit 0
}

# Options
while getopts "t:vh" opt; do
  case "$opt" in
    t) duration="$OPTARG";;
    v) verbose=true;;
    h) usage;;
    *) usage;;
  esac
done

# Add duration to IPERF_OPTS
IPERF_OPTS="-t $duration $IPERF_OPTS"

echo "- Running: ${duration}s test with 4 streams (1s warmup) - both directions (-h for help)"
echo "- Command: iperf3 -c $IPERF_TARGET $IPERF_OPTS  (-R)"

# Download (server → client)
download_json=$(iperf3 -c "$IPERF_TARGET" $IPERF_OPTS -R -J)
download=$(echo "$download_json" | jq '.end.sum_received.bits_per_second / 1e6 | round')
if [ "$verbose" = true ]; then
  echo "  - Down: ${download} Mbps"
fi

# Upload (client → server)
upload_json=$(iperf3 -c "$IPERF_TARGET" $IPERF_OPTS -J)
upload=$(echo "$upload_json" | jq '.end.sum_sent.bits_per_second / 1e6 | round')
if [ "$verbose" = true ]; then
  echo "  - Up: ${upload} Mbps"
fi

# Output
echo "Location: $LOCATION | Down: ${download} Mbps | Up: ${upload} Mbps"
