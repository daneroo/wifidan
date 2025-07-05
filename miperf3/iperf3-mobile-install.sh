#!/bin/sh

# Installer for iperf3 mobile testing script
# Creates miperf3.sh with the testing functionality
# Pushed as a gist: https://gist.github.com/daneroo/f172382fe6027a20c4d910541f1ff708
# and a shortened url: https://bit.ly/miperf3-inst

cat > miperf3.sh <<'EOT'
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
EOT

chmod +x miperf3.sh
echo "✓ Created miperf3.sh"

# Detect platform
if command -v apk >/dev/null 2>&1; then
    echo "- Detected iSH"
elif command -v pkg >/dev/null 2>&1; then
    echo "- Detected Termux"
fi

# Check dependencies
echo "- Checking dependencies"
missing_deps=""
for dep in bash iperf3 jq; do
    if command -v "$dep" >/dev/null 2>&1; then
        echo "✓ $dep"
    else
        echo "✗ $dep missing"
        missing_deps="$missing_deps $dep"
    fi
done

# Show install command if needed
if [ -n "$missing_deps" ]; then
    if command -v apk >/dev/null 2>&1; then
        install_cmd="apk update && apk add$missing_deps"
    elif command -v pkg >/dev/null 2>&1; then
        install_cmd="pkg install$missing_deps"
    fi
    
    echo "$install_cmd"
    printf "Shall I install them for you? y/N: "
    read answer < /dev/tty  # Read from terminal, not from curl pipe
    
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        eval "$install_cmd"
    fi
fi
echo "- You can now run ./miperf3.sh [-h] [-t <seconds>] [-v]"

