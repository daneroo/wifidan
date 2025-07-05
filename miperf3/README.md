# miperf3 - Installer Script

Because I found the available tools to be seriously lacking or ridiculously expensive, I simply created a simple way to run iperf3, on both my mobile devices.

Using [Ish](https://ish.app/) and [Termux](https://wiki.termux.com/wiki/Main_Page), I was able to install a script to run iperf3 in both of these environments with a simple, one-liner.

The script is embedded in an installer script, which is published to a shorted url.

- Bitly short URL: <https://bit.ly/miperf3-inst>
- Points to Gist permanent URL: <https://gist.githubusercontent.com/daneroo/f172382fe6027a20c4d910541f1ff708/raw/iperf3-mobile-install.sh>
- `iperf3-mobile-install.sh` - Cross-platform installer script
- `miperf3.sh` - The file that the installer creates on the client device

Usage (on the client device):

```bash
# Install the tool
curl -sL bit.ly/miperf3-inst | sh

# Run speed test
./miperf3.sh
```

Publish a new version by:

```bash
# Update the gist with latest version
gh gist edit f172382fe6027a20c4d910541f1ff708 --add ./iperf3-mobile-install.sh

# Original gist creation (for reference)
gh gist create ./iperf3-mobile-install.sh --public --desc "iperf3 mobile testing script installer"
```
