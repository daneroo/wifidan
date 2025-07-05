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
