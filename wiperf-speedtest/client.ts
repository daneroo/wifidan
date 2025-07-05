/// <reference lib="dom" />
/**
 * Wiperf Speed Test Client
 *
 * WebSocket-based network speed testing application with real-time progress tracking.
 *
 * Architecture:
 * - Single global state machine (clientState)
 * - WebSocket connection to server for test coordination
 * - UI controls for test configuration (direction, duration, payload size)
 * - Real-time speed display with progress tracking
 * - Theme switching (light/dark/system)
 *
 * Test Flow:
 * 1. User configures test parameters and clicks "Start Test"
 * 2. Client sends start message to server with test configuration
 * 3. Client transitions to upload/download state and begins data transfer
 * 4. Real-time progress updates during test execution
 * 5. Test completion (timer or manual stop) triggers result calculation
 * 6. Client transitions back to ready state for next test
 *
 * State Management:
 * - All state transitions are explicit and documented
 * - Race conditions prevented through proper state isolation
 * - UI locking during active tests prevents parameter changes
 */

// Upload flooding constants
const MiB = 1024 * 1024;
// These should be relative to PAYLOAD_SIZE_BYTES
const BACKPRESSURE_THRESHOLD_BYTES = 16 * MiB; // in bytes - pause sending (client-side only)
const BACKPRESSURE_WARNING_BYTES = 8 * MiB; // in bytes - monitor closely (client-side only)

// Global configuration values from UI controls
const controlConfigValues = {
  direction: "upload" as "upload" | "download" | "bidirectional",
  durationMs: 3 * 1000, // milliseconds
  payloadSizeBytes: 4 * MiB, // bytes
  logLevel: "info" as "debug" | "info" | "error", // logging control
};

declare global {
  var lucide: { createIcons(): void } | undefined;
}

// Wire protocol types - these match the server's ServerMessage types
type ServerMessage =
  | {
      type: "uploadProgress";
      elapsedMs: number; // Elapsed time since test start (ms)
      receivedBytes: number; // Total bytes received so far
      progressPercent: number; // Completion percentage (0–100)
    }
  | {
      type: "uploadResult";
      elapsedMs: number; // Total test duration (ms)
      receivedBytes: number; // Total bytes received
    }
  | {
      type: "downloadComplete";
      // Acknowledgment message to complete state transition out of 'download'
      // Client sends stopDownload → Server stops flooding → Server sends this ack
      // This triggers client to transition from download → ready state
      // No data fields needed - client calculated its own speed/bytes during test
    };

// Wire protocol types - these match the server's Action types
type Action =
  | { type: "startUpload"; durationMs: number }
  | { type: "startDownload"; durationMs: number; payloadSizeBytes: number }
  | { type: "stopUpload" }
  | { type: "stopDownload" }
  | { type: "uploadData"; data: ArrayBuffer };

/**
 * Client State Management
 *
 * The client uses a discriminated union state machine to manage WebSocket connection
 * and test execution. All state transitions are handled through explicit state changes
 * to ensure consistency and prevent race conditions.
 *
 * Global State: clientState (single source of truth)
 * State Authority: Client controls all state transitions
 * Thread Safety: Single-threaded JavaScript, no concurrent access issues
 */

// === CLIENT STATE TYPES ===

/** No WebSocket connection - attempting to reconnect */
type DisconnectedState = {
  status: "disconnected";
  ws: null;
};

/** Connected and ready to start tests */
type ReadyState = {
  status: "ready";
  ws: WebSocket;
};

/** Upload test in progress - client sending data to server */
type UploadState = {
  status: "upload";
  ws: WebSocket;
  uploadInterval: number; // setTimeout ID for upload flooding loop
  uploadPayload: ArrayBuffer; // Reusable payload buffer (zero-filled)
};

/** Download test in progress - client receiving data from server */
type DownloadState = {
  status: "download";
  ws: WebSocket;
  downloadBytesReceived: number; // Total bytes received (-1 = first payload sentinel)
  downloadStartTimeClient: number; // performance.now() when test started
  downloadLastReceivedTimeClient: number; // performance.now() of last payload received (used for final speed calculation)
  downloadCompleted: boolean; // Flag to ignore payloads after test completion
};

/** Test completed - waiting for UI reset */
type CompletedState = {
  status: "completed";
  ws: WebSocket;
};

/** Error state - connection or test failure */
type ErrorState = {
  status: "error";
  ws: WebSocket | null;
};

/** Main client state discriminated union */
type ClientState =
  | DisconnectedState
  | ReadyState
  | UploadState
  | DownloadState
  | CompletedState
  | ErrorState;

// Theme Switcher Functionality
function initTheme() {
  const savedTheme = localStorage.getItem("wiperf-theme") || "system";
  setTheme(savedTheme);
}

function setTheme(theme: string) {
  const root = document.documentElement;
  const buttons = document.querySelectorAll(".theme-option");

  // Update data attribute
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }

  // Update active button
  buttons.forEach((btn) => {
    const htmlBtn = btn as HTMLElement;
    htmlBtn.classList.toggle("active", htmlBtn.dataset.theme === theme);
  });

  // Save preference
  localStorage.setItem("wiperf-theme", theme);
}

/**
 * Formats a speed value in Mbps to a human-readable string with appropriate units.
 * For speeds > 0 and < 10 Mbps, converts to kbps for better precision.
 * For speed = 0 or >= 10, displays in Mbps.
 * Caps the maximum displayed speed at 99,999.9 Mbps.
 *
 * @param speedMbps - The speed to format in megabits per second (Mbps)
 * @returns An object containing the formatted number as a string and the unit (either "kbps" or "Mbps")
 */
function formatSpeed(speedMbps: number): { number: string; unit: string } {
  // Cap at 99_999.9 Mbps
  speedMbps = Math.min(speedMbps, 99_999.9);

  if (speedMbps > 0 && speedMbps < 10) {
    // Low speeds: show as Kbps for better precision
    return {
      number: (speedMbps * 1000).toFixed(1),
      unit: "kbps",
    };
  } else {
    // All other cases (0 or >= 10): show as Mbps
    return {
      number: speedMbps.toFixed(1),
      unit: "Mbps",
    };
  }
}

function updateSpeedDisplay(
  speedMbps: number,
  status: string,
  progress: string,
  progressPercent: number
) {
  const formattedSpeed = formatSpeed(speedMbps);
  document.getElementById("speed-number")!.textContent = formattedSpeed.number;
  document.getElementById("speed-unit")!.textContent = formattedSpeed.unit;
  document.getElementById("test-status")!.textContent = status;
  document.getElementById("test-progress")!.textContent = progress;
  (document.getElementById("progress-bar") as HTMLElement)!.style.width =
    progressPercent + "%";
}

// === GLOBAL STATE ===

/**
 * Global client state - single source of truth for all client operations
 *
 * This is the only global state variable in the application. All state transitions
 * must go through explicit state changes to maintain consistency.
 *
 * State transitions are triggered by:
 * - WebSocket events (connect, disconnect, error)
 * - User actions (start/stop test)
 * - Test completion (timer expiration, manual stop)
 * - Server messages (result messages)
 */
let clientState: ClientState = { status: "disconnected", ws: null };

function updateDebugDisplay() {
  const wsStateEl = document.getElementById("ws-state");
  const clientStateEl = document.getElementById("client-state");

  if (clientState.ws) {
    switch (clientState.ws.readyState) {
      case WebSocket.CONNECTING:
        wsStateEl!.textContent = "Connecting";
        wsStateEl!.style.color = "var(--warning)";
        break;
      case WebSocket.OPEN:
        wsStateEl!.textContent = "Connected";
        wsStateEl!.style.color = "var(--success)";
        break;
      case WebSocket.CLOSING:
        wsStateEl!.textContent = "Closing";
        wsStateEl!.style.color = "var(--warning)";
        break;
      case WebSocket.CLOSED:
        wsStateEl!.textContent = "Closed";
        wsStateEl!.style.color = "var(--error)";
        break;
    }
  } else {
    wsStateEl!.textContent = "Disconnected";
    wsStateEl!.style.color = "var(--error)";
  }

  clientStateEl!.textContent = clientState.status;
  switch (clientState.status) {
    case "ready":
      clientStateEl!.style.color = "var(--success)";
      break;
    case "upload":
    case "download":
      clientStateEl!.style.color = "var(--accent-primary)";
      break;
    case "error":
      clientStateEl!.style.color = "var(--error)";
      break;
    default:
      clientStateEl!.style.color = "var(--text-secondary)";
  }

  // Update buffer status
  const bufferStatusEl = document.getElementById("buffer-status");
  if (clientState.ws && clientState.ws.readyState === WebSocket.OPEN) {
    const bufferBytes = clientState.ws.bufferedAmount;

    // Display in MiB for larger values, KiB for smaller
    let bufferDisplay, unit;
    if (bufferBytes >= 1024 * 1024) {
      bufferDisplay = (bufferBytes / (1024 * 1024)).toFixed(1);
      unit = "MiB";
    } else {
      bufferDisplay = Math.floor(bufferBytes / 1024);
      unit = "KiB";
    }

    if (bufferBytes >= BACKPRESSURE_THRESHOLD_BYTES) {
      // Over threshold - critical (red)
      bufferStatusEl!.textContent = `${bufferDisplay} ${unit}`;
      bufferStatusEl!.style.color = "var(--error)";
    } else if (bufferBytes >= BACKPRESSURE_WARNING_BYTES) {
      // Warning level (yellow)
      bufferStatusEl!.textContent = `${bufferDisplay} ${unit}`;
      bufferStatusEl!.style.color = "var(--warning)";
    } else {
      // Normal level (secondary text)
      bufferStatusEl!.textContent = `${bufferDisplay} ${unit}`;
      bufferStatusEl!.style.color = "var(--text-secondary)";
    }
  } else {
    bufferStatusEl!.textContent = "N/A";
    bufferStatusEl!.style.color = "var(--text-secondary)";
  }

  // Update button states after debug display
  updateButtonStates();
}

// Update button enabled/disabled state based on connection and client state
function updateButtonStates() {
  const startButton = document.getElementById("start-button");

  const isConnected =
    clientState.ws && clientState.ws.readyState === WebSocket.OPEN;
  const hasError = clientState.status === "error";
  const isTestActive = clientState.status !== "ready";

  // Start button: enabled when connected and no error
  (startButton as HTMLButtonElement)!.disabled = !isConnected || hasError;

  // Lock/unlock control panel during active tests
  updateControlPanelLock(isTestActive);
}

// Lock or unlock the control panel inputs during active tests
function updateControlPanelLock(isLocked: boolean) {
  // Direction controls
  document.querySelectorAll('input[name="direction"]').forEach((input) => {
    (input as HTMLInputElement).disabled = isLocked;
  });

  // Duration controls
  document.querySelectorAll('input[name="duration"]').forEach((input) => {
    (input as HTMLInputElement).disabled = isLocked;
  });

  // Payload controls
  document.querySelectorAll('input[name="payload"]').forEach((input) => {
    (input as HTMLInputElement).disabled = isLocked;
  });

  // Log level dropdown (allow changing during tests for debugging)
  const logLevelSelect = document.getElementById(
    "log-level"
  ) as HTMLSelectElement;
  if (logLevelSelect) {
    // Keep log level unlocked - useful for debugging during tests
    logLevelSelect.disabled = false;
  }
}

function connectWebSocket() {
  if (clientState.ws) return;

  const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = protocol + "//" + globalThis.location.host + "/ws";

  const ws = new WebSocket(wsUrl);

  // Fix binary data asymmetry: Browser defaults to Blob, but our server uses ArrayBuffer
  // Setting this makes both upload (client→server) and download (server→client) use ArrayBuffer
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // STATE TRANSITION: disconnected → ready
    clientState = { status: "ready", ws: ws };
    updateDebugDisplay();
    logInfo("WebSocket connected");
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      // Handle control messages (JSON)
      try {
        const message = JSON.parse(event.data);
        handleServerMessage(message);
      } catch (error) {
        logError("Failed to parse server message:", error);
        // STATE TRANSITION: any → error (protocol error)
        clientState = { status: "error", ws: clientState.ws };
        resetToIdle();
      }
    } else {
      // Handle payload messages (binary) - for download tests
      handlePayloadMessage(event.data);
    }
  };

  ws.onclose = () => {
    logInfo("WebSocket disconnected");

    // Hard reset - stop all operations and reset UI
    resetToIdle();

    // STATE TRANSITION: any → disconnected
    clientState = { status: "disconnected", ws: null };

    // Attempt to reconnect after 2 seconds
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = (error) => {
    logError("WebSocket error:", error);

    // STATE TRANSITION: any → error (connection error)
    clientState = { status: "error", ws: clientState.ws };
    resetToIdle();
  };

  updateDebugDisplay();
}

/**
 * Handle JSON control messages from server
 *
 * This function processes server messages (progress updates and test results).
 * It handles the final state transitions when tests complete.
 *
 * Message types:
 * - uploadProgress: Real-time updates during upload tests (server-calculated)
 * - uploadResult: Final test results (server-calculated for upload, client-calculated for download)
 * - downloadComplete: Acknowledgment message to complete state transition out of 'download'
 *
 * State transitions:
 * - upload/download → ready: When result message received
 * - UI reset: 2-second timer after completion
 *
 * @param message - JSON message from server
 */
function handleServerMessage(message: ServerMessage) {
  switch (message.type) {
    case "uploadProgress": {
      if (clientState.status === "download") {
        logError(
          "Ignoring server progress for download (client calculates own progress) should not happen"
        );
        break;
      } else if (clientState.status === "upload") {
        logDebug("Got server progress for upload", JSON.stringify(message));
      } else {
        logError("Unknown client state:", clientState.status);
        break;
      }

      // Upload progress - use server's timing and progressPercent
      // Speed calculation: bytes * 8 bits/byte * 1000 ms/s / elapsed_ms / (1024^2) bits/Mbps
      const speedMbps =
        (message.receivedBytes * 8 * 1000) / message.elapsedMs / (1024 * 1024);
      const bytesKiB = Math.floor(message.receivedBytes / 1024);
      updateSpeedDisplay(
        speedMbps,
        `Testing... ${clientState.status}`,
        `${bytesKiB} kiB transferred`,
        message.progressPercent
      );
      break;
    }
    case "uploadResult": {
      // Upload: Server measures server-side timing (start/end times not visible to client)
      // Download: Client measures downloadStartTimeClient -> downloadLastReceivedTimeClient (set in progress messages)
      if (clientState.status === "upload") {
        // Upload: Server measurement is valid (server received the data)
        // Speed calculation: bytes * 8 bits/byte * 1000 ms/s / elapsed_ms / (1024^2) bits/Mbps
        const speedMbps =
          (message.receivedBytes * 8 * 1000) /
          message.elapsedMs /
          (1024 * 1024);
        const bytesKiB = Math.floor(message.receivedBytes / 1024);

        logInfo(
          `Upload speed (server calculated): ${speedMbps.toFixed(1)} Mbps`
        );

        updateSpeedDisplay(speedMbps, "Complete", `${bytesKiB} kiB total`, 100);
        stopUploadTest(); // Stop the flooding loop
      } else if (clientState.status === "download") {
        // Download: Client measurement is what matters
        const downloadState = clientState as DownloadState;

        // Use last payload received time for more accurate timing (legacy logic)
        const elapsedMs =
          downloadState.downloadLastReceivedTimeClient > 0
            ? downloadState.downloadLastReceivedTimeClient -
              downloadState.downloadStartTimeClient
            : performance.now() - downloadState.downloadStartTimeClient;

        // Speed calculation: bytes * 8 bits/byte * 1000 ms/s / elapsed_ms / (1024^2) bits/Mbps
        const speedMbps =
          (downloadState.downloadBytesReceived * 8 * 1000) /
          elapsedMs /
          (1024 * 1024);
        const bytesKiB = Math.floor(downloadState.downloadBytesReceived / 1024);

        logInfo(
          `Download speed (client calculated): ${speedMbps.toFixed(1)} Mbps (${
            downloadState.downloadBytesReceived
          } bytes in ${elapsedMs.toFixed(1)}ms)`
        );

        updateSpeedDisplay(speedMbps, "Complete", `${bytesKiB} kiB total`, 100);
        // No active process to stop for downloads
      } else {
        // just log it for now, this is a state confusion
        logInfo(
          `Received result message - wrong state: ${
            clientState.status
          } - ${JSON.stringify(message)}`
        );
      }

      // STATE TRANSITION: upload/download → ready (test complete)
      clientState = { status: "ready", ws: clientState.ws! };
      updateDebugDisplay();
      (document.getElementById(
        "start-button"
      ) as HTMLButtonElement)!.textContent = "Start Test";

      // Reset after 2 seconds
      setTimeout(() => {
        updateSpeedDisplay(0, "Ready", "", 0);
      }, 2000);
      break;
    }
    case "downloadComplete": {
      // Download: Client measurement is what matters
      const downloadState = clientState as DownloadState;

      // Use last payload received time for more accurate timing (legacy logic)
      const elapsedMs =
        downloadState.downloadLastReceivedTimeClient > 0
          ? downloadState.downloadLastReceivedTimeClient -
            downloadState.downloadStartTimeClient
          : performance.now() - downloadState.downloadStartTimeClient;

      // Speed calculation: bytes * 8 bits/byte * 1000 ms/s / elapsed_ms / (1024^2) bits/Mbps
      const speedMbps =
        (downloadState.downloadBytesReceived * 8 * 1000) /
        elapsedMs /
        (1024 * 1024);
      const bytesKiB = Math.floor(downloadState.downloadBytesReceived / 1024);

      logInfo(
        `Download speed (client calculated): ${speedMbps.toFixed(1)} Mbps (${
          downloadState.downloadBytesReceived
        } bytes in ${elapsedMs.toFixed(1)}ms)`
      );

      updateSpeedDisplay(speedMbps, "Complete", `${bytesKiB} kiB total`, 100);
      // No active process to stop for downloads

      // STATE TRANSITION: download → ready (test complete)
      clientState = { status: "ready", ws: clientState.ws! };
      updateDebugDisplay();
      (document.getElementById(
        "start-button"
      ) as HTMLButtonElement)!.textContent = "Start Test";

      // Reset after 2 seconds
      setTimeout(() => {
        updateSpeedDisplay(0, "Ready", "", 0);
      }, 2000);
      break;
    }
    default:
      logError("Unknown server message:", message);
  }
}

// Handle binary payload messages (for download tests)
/**
 * Handle binary payload messages from server (download tests only)
 *
 * This function processes ArrayBuffer payloads received during download tests.
 * It implements the "steady state" timing model where the clock starts on the
 * first payload received, not when the test was initiated.
 *
 * Key behaviors:
 * - First payload: Reset clock and ignore payload (timing correction)
 * - Normal payloads: Accumulate bytes and update progress
 * - Completion detection: Set completion flag and send stopDownload
 * - Post-completion: Ignore additional payloads until server result
 *
 * @param data - ArrayBuffer payload from server
 */
function handlePayloadMessage(data: ArrayBuffer) {
  if (clientState.status === "download") {
    const downloadState = clientState as DownloadState;

    // Check if download test is already completed - ignore additional payloads
    if (downloadState.downloadCompleted) {
      logDebug(
        `Ignoring payload - download test already completed - payload size: ${data.byteLength} bytes`
      );
      return;
    }

    // Log every payload received (ArrayBuffer guaranteed due to ws.binaryType = 'arraybuffer')
    logDebug(
      `Payload received at ${new Date().toISOString()} - ${
        data.byteLength
      } bytes`
    );

    // RESET CLOCK ON FIRST PAYLOAD - to correct for the flawed assumption
    // And IGNORE THE FIRST PAYLOAD - early return
    if (downloadState.downloadBytesReceived === -1) {
      const correctedStartTimeClient = performance.now();
      logDebug(
        `RESET CLOCK ON FIRST PAYLOAD - delta: ${
          correctedStartTimeClient - downloadState.downloadStartTimeClient
        }ms`
      );
      clientState = {
        ...downloadState,
        downloadStartTimeClient: correctedStartTimeClient, // Reset to first payload time
        downloadBytesReceived: 0, // reset to zero
        downloadLastReceivedTimeClient: correctedStartTimeClient,
        downloadCompleted: false, // Ensure completion flag is reset
      };
      return;
    }

    // Update download state with new data FIRST
    const newBytesReceived =
      downloadState.downloadBytesReceived + data.byteLength;
    const newLastReceivedTime = performance.now();

    // STATE TRANSITION: download → download (update bytes received and timing)
    clientState = {
      ...downloadState,
      downloadBytesReceived: newBytesReceived,
      downloadLastReceivedTimeClient: newLastReceivedTime,
    };

    // Calculate progress and check completion using updated state values
    const elapsedSoFar =
      performance.now() - clientState.downloadStartTimeClient;
    const speedBitsPerSec =
      elapsedSoFar > 0
        ? Math.floor(
            (clientState.downloadBytesReceived * 8 * 1000) / elapsedSoFar
          )
        : 0;
    const speedMbps = speedBitsPerSec / (1024 * 1024); // Line protocol artifact
    const bytesKiB = Math.floor(clientState.downloadBytesReceived / 1024);

    // Progress based on elapsed time vs test duration (max 100%)
    const progressPercent = Math.min(
      (elapsedSoFar / controlConfigValues.durationMs) * 100,
      100
    );

    // Check if download test duration is complete
    if (elapsedSoFar >= controlConfigValues.durationMs) {
      // STATE TRANSITION: download → completed (client-detected completion)
      logInfo(
        `Download handler elapsed>duration speed: ${speedMbps.toFixed(
          1
        )}Mbps elapsed: ${elapsedSoFar}ms bytes: ${
          clientState.downloadBytesReceived
        }`
      );

      updateSpeedDisplay(speedMbps, "Complete", `${bytesKiB} kiB total`, 100);

      // Set completion flag to ignore additional payloads from server
      // This prevents multiple stopDownload messages and duplicate processing
      clientState = {
        ...clientState,
        downloadCompleted: true,
      };

      // Send stop message to server (only once - prevented by downloadCompleted flag)
      sendControlMessage({ type: "stopDownload" });

      // Don't transition to ready state here - wait for server result message
      // The server will send a result message which will trigger the state transition
      // This ensures proper handshake and prevents race conditions

      return; // Don't update progress display below
    }

    updateSpeedDisplay(
      speedMbps,
      `Testing... ${clientState.status}`,
      `${bytesKiB} kiB received`,
      progressPercent
    );
  } else {
    logDebug(
      "Ignoring payload - status: `" +
        clientState.status +
        "` payload size: " +
        data.byteLength +
        " bytes"
    );
  }
}

function sendControlMessage(message: Action) {
  if (clientState.ws && clientState.ws.readyState === WebSocket.OPEN) {
    clientState.ws.send(JSON.stringify(message));
  } else {
    logError("WebSocket not connected");
  }
}

// Start upload test - client sends data to server
function startUploadTest() {
  if (clientState.status !== "upload") return; // Wrong state

  const uploadState = clientState as UploadState;
  if (uploadState.uploadInterval !== 0) return; // Already running

  // LOG: Client upload start
  logInfo(`Upload test started at ${new Date().toISOString()}`);

  const payload = uploadState.uploadPayload;

  // Flood the connection with backpressure control
  function sendUploadChunk() {
    if (
      clientState.status !== "upload" ||
      !clientState.ws ||
      clientState.ws.readyState !== WebSocket.OPEN
    ) {
      stopUploadTest();
      return;
    }

    // Check backpressure before sending
    if (clientState.ws.bufferedAmount >= BACKPRESSURE_THRESHOLD_BYTES) {
      // Buffer is full, schedule retry without sending
      const timeoutId = setTimeout(sendUploadChunk, 1); // Retry in 1ms
      // STATE TRANSITION: upload → upload (update timeout)
      clientState = {
        ...(clientState as UploadState),
        uploadInterval: timeoutId,
      };
      return;
    }

    try {
      clientState.ws.send(payload);
      // Schedule next send immediately (flood the connection)
      const timeoutId = setTimeout(sendUploadChunk, 0);
      // STATE TRANSITION: upload → upload (update timeout)
      clientState = {
        ...(clientState as UploadState),
        uploadInterval: timeoutId,
      };
    } catch (error) {
      logError("Error sending upload payload:", error);
      // STATE TRANSITION: upload → error (connection issues)
      clientState = { status: "error", ws: clientState.ws };
      resetToIdle();
    }
  }

  // Start the flooding
  sendUploadChunk();
}

// Stop upload test
function stopUploadTest() {
  if (clientState.status === "upload") {
    const uploadState = clientState as UploadState;
    if (uploadState.uploadInterval !== 0) {
      // LOG: Client upload stop
      logInfo(`Upload test stopped at ${new Date().toISOString()}`);
      clearTimeout(uploadState.uploadInterval);
      // STATE TRANSITION: upload → upload (clear timeout)
      clientState = { ...uploadState, uploadInterval: 0 };
    }
  }
}

// Hard reset - stop all operations and reset UI to idle state
function resetToIdle() {
  // Stop all active operations
  stopUploadTest();

  // Reset UI state
  updateSpeedDisplay(0, "Ready", "", 0);

  // Reset button states
  const startButton = document.getElementById("start-button");
  (startButton as HTMLButtonElement)!.textContent = "Start Test";

  // STATE TRANSITION: any → ready/disconnected (based on connection)
  if (clientState.ws && clientState.ws.readyState === WebSocket.OPEN) {
    clientState = { status: "ready", ws: clientState.ws };
  } else {
    clientState = { status: "disconnected", ws: null };
  }

  updateDebugDisplay();
}

// Real Test Functionality
function startRealTest() {
  if (clientState.status !== "ready") {
    logError(`Cannot start test - not ready (${clientState.status})`);
    return;
  }

  // Get selected direction from config
  const direction = controlConfigValues.direction;
  let testType;

  // Map UI values to protocol values
  if (direction === "upload") {
    testType = "upload";
  } else if (direction === "download") {
    testType = "download";
  } else if (direction === "bidirectional") {
    // For "both" we'll start with upload first
    testType = "upload";
  } else {
    logError("Unknown direction:", direction);
    return;
  }

  // Send start message
  const message: Action =
    testType === "upload"
      ? {
          type: "startUpload",
          durationMs: controlConfigValues.durationMs,
        }
      : {
          type: "startDownload",
          durationMs: controlConfigValues.durationMs,
          payloadSizeBytes: controlConfigValues.payloadSizeBytes,
        };

  sendControlMessage(message);

  // STATE TRANSITION: ready → upload/download (start test)
  if (testType === "upload") {
    clientState = {
      status: "upload",
      ws: clientState.ws!,
      uploadInterval: 0,
      // No need to fill with pattern - zeros are sufficient for speed testing
      uploadPayload: new ArrayBuffer(controlConfigValues.payloadSizeBytes),
    };
    updateDebugDisplay();
    startUploadTest();
  } else if (testType === "download") {
    // LOG: Client download start
    logInfo(`Download test started at ${new Date().toISOString()}`);
    clientState = {
      status: "download",
      ws: clientState.ws!,
      downloadBytesReceived: -1, // sentinel to discard first payload
      downloadStartTimeClient: performance.now(),
      downloadLastReceivedTimeClient: 0,
      downloadCompleted: false, // Flag to ignore payloads after test completion
    };
    updateDebugDisplay();
  }

  // Update UI
  updateSpeedDisplay(0, "Starting...", "", 0);
  (document.getElementById("start-button") as HTMLButtonElement)!.textContent =
    "Stop Test";
}

function stopRealTest() {
  if (clientState.status === "upload" || clientState.status === "download") {
    // Stop upload test if running
    stopUploadTest();

    // Send stop message based on current state
    sendControlMessage(
      clientState.status === "upload"
        ? { type: "stopUpload" }
        : { type: "stopDownload" }
    );
    // STATE TRANSITION: upload/download → ready (test stopped)
    clientState = { status: "ready", ws: clientState.ws! };
    updateDebugDisplay();
    (document.getElementById(
      "start-button"
    ) as HTMLButtonElement)!.textContent = "Start Test";
  }
}

function handleStartButtonClick() {
  const button = document.getElementById("start-button") as HTMLButtonElement;
  if (button!.textContent === "Start Test") {
    startRealTest();
  } else {
    stopRealTest();
  }
}

// Initialize control config values from UI
function initControlConfigValues() {
  // Direction
  const directionInput = document.querySelector(
    'input[name="direction"]:checked'
  ) as HTMLInputElement;
  if (directionInput) {
    controlConfigValues.direction = directionInput.value as
      | "upload"
      | "download"
      | "bidirectional";
  }

  // Duration
  const durationInput = document.querySelector(
    'input[name="duration"]:checked'
  ) as HTMLInputElement;
  if (durationInput) {
    controlConfigValues.durationMs = parseInt(durationInput.value) * 1000;
  }

  // Payload
  const payloadInput = document.querySelector(
    'input[name="payload"]:checked'
  ) as HTMLInputElement;
  if (payloadInput) {
    controlConfigValues.payloadSizeBytes = parseInt(payloadInput.value) * MiB;
  }

  // Log Level
  const logLevelSelect = document.getElementById(
    "log-level"
  ) as HTMLSelectElement;
  if (logLevelSelect) {
    controlConfigValues.logLevel = logLevelSelect.value as
      | "debug"
      | "info"
      | "error";
  }

  logDebug("Control config initialized:", controlConfigValues);
}

// Update control config values when UI changes
function setupControlConfigListeners() {
  // Direction change listeners
  document.querySelectorAll('input[name="direction"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        controlConfigValues.direction = target.value as
          | "upload"
          | "download"
          | "bidirectional";
        logDebug("Direction changed to:", controlConfigValues.direction);
      }
    });
  });

  // Duration change listeners
  document.querySelectorAll('input[name="duration"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        controlConfigValues.durationMs = parseInt(target.value) * 1000;
        logDebug("Duration changed to:", controlConfigValues.durationMs, "ms");
      }
    });
  });

  // Payload change listeners
  document.querySelectorAll('input[name="payload"]').forEach((input) => {
    input.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.checked) {
        controlConfigValues.payloadSizeBytes = parseInt(target.value) * MiB;
        logDebug(
          "Payload changed to:",
          controlConfigValues.payloadSizeBytes,
          "bytes"
        );
      }
    });
  });

  // Log Level change listener
  const logLevelSelect = document.getElementById(
    "log-level"
  ) as HTMLSelectElement;
  if (logLevelSelect) {
    logLevelSelect.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      controlConfigValues.logLevel = target.value as "debug" | "info" | "error";
      logDebug("Log level changed to:", controlConfigValues.logLevel);
    });
  }
}

// Theme switcher event listeners
document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide icons
  globalThis.lucide?.createIcons();

  initTheme();

  document.querySelectorAll(".theme-option").forEach((button) => {
    button.addEventListener("click", () => {
      setTheme((button as HTMLElement).dataset.theme!);
    });
  });

  // Initialize control config values from UI
  initControlConfigValues();
  setupControlConfigListeners();

  // Real test button
  document
    .getElementById("start-button")!
    .addEventListener("click", handleStartButtonClick);

  // Initialize WebSocket connection
  connectWebSocket();

  // Update debug display periodically
  setInterval(updateDebugDisplay, 1000);
});

logInfo("WiFiDan/wiperf speed-test started");

// === LOGGING FUNCTIONS ===

function logError(message: string, ...args: unknown[]): void {
  console.error(`[ERROR] ${message}`, ...args);
}

function logInfo(message: string, ...args: unknown[]): void {
  if (
    controlConfigValues.logLevel === "debug" ||
    controlConfigValues.logLevel === "info"
  ) {
    console.log(`[INFO] ${message}`, ...args);
  }
}

function logDebug(message: string, ...args: unknown[]): void {
  if (controlConfigValues.logLevel === "debug") {
    console.log(`[DEBUG] ${message}`, ...args);
  }
}
