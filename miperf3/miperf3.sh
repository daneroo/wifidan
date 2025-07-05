#!/usr/bin/env bash

# This script was installed on my mobile devices using the following command:
# curl -L https://bit.ly/miperf3-inst | sh

# Take iperf3 measurements on mobile devices
# Ish- https://ish.app/
# Temux- https://wiki.termux.com/wiki/Main_Page

# Config
IPERF_TARGET="192.168.2.33"
IPERF_OPTS="-t 10 -P 4 -O 2"  # 10s test, 4 streams, 2s warmup
LOCATION="UNSET"

echo "- Running: 10s test with 4 streams (2s warmup) - both directions"
echo "- Command: iperf3 -c $IPERF_TARGET $IPERF_OPTS"

# Download (server → client)
download=$(iperf3 -c "$IPERF_TARGET" $IPERF_OPTS -R -J | jq '.end.sum_received.bits_per_second / 1e6 | round')

# Upload (client → server)
upload=$(iperf3 -c "$IPERF_TARGET" $IPERF_OPTS -J | jq '.end.sum_sent.bits_per_second / 1e6 | round')

# Output
echo "Location: $LOCATION | Down: ${download} Mbps | Up: ${upload} Mbps"
