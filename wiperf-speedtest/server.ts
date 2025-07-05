// TypeScript transpilation for client-side code
import { transpile } from "jsr:@deno/emit";

// === WIRE PROTOCOL TYPES ===
// These represent the messages sent over the WebSocket wire protocol
type Action =
  | { type: "startUpload"; durationMs: number }
  | { type: "startDownload"; durationMs: number; payloadSizeBytes: number }
  | { type: "stopUpload" }
  | { type: "stopDownload" }
  | { type: "uploadData"; data: ArrayBuffer };

// Wire protocol types - these match the client's ServerMessage types
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

// Constants
// The download timing is under the client control, the server cooperates
// by sending the payload as fast as possible for the requested duration
// This is the extra time we continue to push payloads to account for the ambiguity in timing
// In actuality, when the client completes according to it's duration,
// The client sends a stopDownload message, and the server terminates the flooding
// so this is just a cautionary buffer time, it does not cause extra flooding in practice
const DOWNLOAD_DURATION_BUFFER_MS = 500;
// Sentinel values for ClientState.downloadFloodTimer (Deno says setTimeout return a number)
const FLOOD_ACTIVE_NOT_YET_SCHEDULED = -1;
const FLOOD_CANCELLED = -2;

/**
 * Per-client state tracking
 *
 * State transitions:
 * - Clients start as "idle" when WebSocket connects
 * - Server changes status to "upload" or "download" in response to client "start" messages
 * - Server resets status back to "idle" when test completes or client sends "stop"
 *
 * Authority: The server is authoritative over client state. Clients cannot
 * unilaterally change their status - they must send control messages to request
 * state changes, and the server decides whether to honor the request.
 */
type IdleState = { status: "idle" };

type UploadState = {
  status: "upload";
  startTimeOnServerMs: number; // When upload test started on server
  requestedDurationMs: number; // Duration requested by client in milliseconds
  bytesReceived: number; // Total bytes received from client during upload
};

type DownloadState = {
  status: "download";
  startTimeOnServerMs: number; // When download test started on server
  requestedDurationMs: number; // Duration requested by client in milliseconds
  downloadFloodTimer: number; // Timer ID for the flooding loop
};

type ClientState = IdleState | UploadState | DownloadState;

main();

function main() {
  // Note: We could return the Deno.HttpServer object from Deno.serve(),
  // but we have no use for it currently
  // Track connected clients with their state (scoped to this server instance)
  const clients = new Map<WebSocket, ClientState>();

  // this is just to stop the download flood when the client errors or disconnects
  function cleanupForDownloadFlood(socket: WebSocket) {
    const clientState = clients.get(socket);
    if (
      clientState?.status === "download" &&
      clientState.downloadFloodTimer > 0 // means actually running!
    ) {
      console.log(
        "WebSocket cleanup - cancelling download flood",
        clientState.downloadFloodTimer
      );
      clearTimeout(clientState.downloadFloodTimer);
      clientState.downloadFloodTimer = FLOOD_CANCELLED;
    }
  }

  console.log("Server running at http://localhost:8000");
  console.log("Files served: index.html, style.css, client.js");
  console.log("WebSocket endpoint: ws://localhost:8000/ws");

  return Deno.serve(
    {
      port: 8000,
      hostname: "0.0.0.0",
    },
    async (req: Request) => {
      const url = new URL(req.url);

      // WebSocket upgrade handler (stub for now)
      if (url.pathname === "/ws") {
        if (req.headers.get("upgrade") !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 400 });
        }

        const { socket, response } = Deno.upgradeWebSocket(req);

        socket.onopen = () => {
          const clientState: ClientState = { status: "idle" };
          clients.set(socket, clientState);
          console.log(`WebSocket connected - Clients: ${clients.size}`);
        };

        socket.onclose = () => {
          cleanupForDownloadFlood(socket);
          clients.delete(socket);
          console.log(`WebSocket disconnected - Clients: ${clients.size}`);
        };

        socket.onerror = (error) => {
          cleanupForDownloadFlood(socket);
          clients.delete(socket);
          logError("WebSocket error", error);
        };

        socket.onmessage = (event) => {
          const clientState = clients.get(socket);
          if (!clientState) {
            console.error(
              "UNEXPECTED ERROR: Message received for unknown client"
            );
            return;
          }

          const newClientState = processMessage(clientState, socket, event);
          clients.set(socket, newClientState);
        };

        return response;
      }

      // Serve static files
      switch (url.pathname) {
        case "/":
          return serveFile("index.html", "text/html; charset=utf-8");
        case "/style.css":
          return serveFile("style.css", "text/css");
        case "/client.js":
        case "/client.ts": {
          // Transpile TypeScript to JavaScript on the fly
          try {
            const url = new URL("./client.ts", import.meta.url);
            const result = await transpile(url);
            const code = result.get(url.href);

            return new Response(code, {
              headers: {
                "content-type": "text/javascript",
                "cache-control": "no-cache", // Always get fresh TypeScript during development
              },
            });
          } catch (error) {
            logError("TypeScript transpilation error", error);
            return new Response("TypeScript compilation failed", {
              status: 500,
            });
          }
        }
        default:
          return new Response("Not Found", { status: 404 });
      }
    }
  );
}

// === DISPATCHER ===

function processMessage(
  clientState: ClientState,
  socket: WebSocket,
  event: MessageEvent
): ClientState {
  // === HANDLER TYPES ===
  type StateHandler<
    TState extends ClientState,
    TAction,
    TResult extends ClientState
  > = (state: TState, socket: WebSocket, action: TAction) => TResult;

  // === REGISTRY TYPE ===
  type StateHandlers = {
    idle: {
      startUpload: StateHandler<
        IdleState,
        Extract<Action, { type: "startUpload" }>,
        UploadState
      >;
      startDownload: StateHandler<
        IdleState,
        Extract<Action, { type: "startDownload" }>,
        DownloadState
      >;
    };
    upload: {
      stopUpload: StateHandler<
        UploadState,
        Extract<Action, { type: "stopUpload" }>,
        IdleState
      >;
      uploadData: StateHandler<
        UploadState,
        Extract<Action, { type: "uploadData" }>,
        UploadState | IdleState
      >;
    };
    download: {
      stopDownload: StateHandler<
        DownloadState,
        Extract<Action, { type: "stopDownload" }>,
        IdleState
      >;
    };
  };

  // Parse event into normalized action
  const action = parseEventToAction(event, clientState);
  if (!action) {
    return clientState;
  }

  // === HANDLER REGISTRY ===
  const STATE_HANDLERS: StateHandlers = {
    idle: {
      startUpload,
      startDownload,
    },
    upload: {
      stopUpload,
      uploadData,
    },
    download: {
      stopDownload,
    },
  };

  // Type-safe handler lookup with proper narrowing
  const stateHandlers = STATE_HANDLERS[clientState.status];
  if (!stateHandlers) {
    console.log(`No handlers for state ${clientState.status} - ignoring`);
    return clientState;
  }

  // @ts-ignore - Dynamic lookup necessary for dispatch pattern
  // deno-lint-ignore no-explicit-any
  const handler = (stateHandlers as any)[action.type];

  if (!handler) {
    console.log(
      `No handler for ${action.type} in state ${clientState.status} - ignoring`
    );
    return clientState;
  }

  return handler(clientState, socket, action);
}

// === MESSAGE PARSER ===
function parseEventToAction(
  event: MessageEvent,
  _currentState: ClientState
): Action | null {
  if (typeof event.data === "string") {
    // Action message (JSON) - simple validation
    try {
      const action = JSON.parse(event.data) as Action;

      // Validate the action structure
      if (action.type === "startUpload" || action.type === "startDownload") {
        if (typeof action.durationMs !== "number" || action.durationMs <= 0) {
          console.log(`Invalid durationMs: ${action.durationMs}`);
          return null;
        }
        if (
          action.type === "startDownload" &&
          (typeof action.payloadSizeBytes !== "number" ||
            action.payloadSizeBytes <= 0)
        ) {
          console.log(`Invalid payloadSizeBytes: ${action.payloadSizeBytes}`);
          return null;
        }
        return action;
      } else if (
        action.type === "stopUpload" ||
        action.type === "stopDownload"
      ) {
        return action;
      } else {
        console.log(`Unknown action type: ${action.type}`);
        return null;
      }
    } catch (error) {
      logError("Invalid action message", error);
      return null;
    }
  } else {
    // Binary data (ArrayBuffer)
    return {
      type: "uploadData",
      data: event.data,
    };
  }
}

// === 5 HANDLER FUNCTIONS ===

function startUpload(
  _state: IdleState,
  _socket: WebSocket,
  action: Extract<Action, { type: "startUpload" }>
): UploadState {
  console.log(
    `STATE TRANSITION: idle → upload - ${action.durationMs}ms duration`
  );
  return {
    status: "upload",
    startTimeOnServerMs: performance.now(),
    requestedDurationMs: action.durationMs,
    bytesReceived: -1, // sentinel to discard first payload
  };
}

function startDownload(
  _state: IdleState,
  socket: WebSocket,
  action: Extract<Action, { type: "startDownload" }>
): DownloadState {
  console.log(
    `STATE TRANSITION: idle → download - ${action.durationMs}ms duration - ${action.payloadSizeBytes} bytes per chunk`
  );

  const newState: DownloadState = {
    status: "download",
    startTimeOnServerMs: performance.now(),
    requestedDurationMs: action.durationMs,
    downloadFloodTimer: FLOOD_ACTIVE_NOT_YET_SCHEDULED,
  };

  // Initiate flooding as part of state transition
  initiateDownloadFlooding(
    socket,
    newState,
    action.durationMs,
    action.payloadSizeBytes
  );

  return newState;
}

function stopUpload(
  state: UploadState,
  socket: WebSocket,
  _action: Extract<Action, { type: "stopUpload" }>
): IdleState {
  console.log("STATE TRANSITION: upload → idle");

  // Send final result message
  const elapsedMs = performance.now() - state.startTimeOnServerMs;

  const resultMessage: ServerMessage = {
    type: "uploadResult",
    elapsedMs: elapsedMs,
    receivedBytes: state.bytesReceived,
  };

  socket.send(JSON.stringify(resultMessage));

  return { status: "idle" };
}

function stopDownload(
  state: DownloadState,
  socket: WebSocket,
  _action: Extract<Action, { type: "stopDownload" }>
): IdleState {
  console.log("STATE TRANSITION: download → idle");

  // Cleanup flooding
  if (state.downloadFloodTimer > 0) {
    clearTimeout(state.downloadFloodTimer);
  }

  // Send acknowledgment to complete state transition out of 'download'
  // Client sends stopDownload → Server stops flooding → Server sends this ack
  const resultMessage: ServerMessage = {
    type: "downloadComplete",
  };

  socket.send(JSON.stringify(resultMessage));

  return { status: "idle" };
}

function uploadData(
  state: UploadState,
  socket: WebSocket,
  action: Extract<Action, { type: "uploadData" }>
): UploadState | IdleState {
  // RESET CLOCK ON FIRST PAYLOAD - to correct for the flawed assumption
  // And IGNORE THE FIRST PAYLOAD - early return
  if (state.bytesReceived === -1) {
    const correctedStartTimeOnServerMs = performance.now();
    console.log(
      `RESET CLOCK ON FIRST PAYLOAD - delta: ${
        correctedStartTimeOnServerMs - state.startTimeOnServerMs
      }ms`
    );
    state.startTimeOnServerMs = correctedStartTimeOnServerMs; // Reset to first payload time
    state.bytesReceived = 0; // reset to zero
    return state;
  }

  const newBytesReceived = state.bytesReceived + action.data.byteLength;
  const elapsedMs = performance.now() - state.startTimeOnServerMs;

  // Check if test is complete
  if (elapsedMs >= state.requestedDurationMs) {
    console.log("STATE TRANSITION: upload → idle (test complete)");

    // Send result and transition to idle
    const resultMessage: ServerMessage = {
      type: "uploadResult",
      elapsedMs: elapsedMs,
      receivedBytes: newBytesReceived,
    };

    socket.send(JSON.stringify(resultMessage));
    return { status: "idle" };
  }

  // Continue upload - send progress
  const updatedState: UploadState = {
    ...state,
    bytesReceived: newBytesReceived,
  };

  const progressPercent = Math.min(
    (elapsedMs / state.requestedDurationMs) * 100,
    100
  );

  const progressMessage: ServerMessage = {
    type: "uploadProgress",
    elapsedMs: elapsedMs,
    receivedBytes: newBytesReceived,
    progressPercent: progressPercent,
  };

  socket.send(JSON.stringify(progressMessage));

  return updatedState;
}

// Download flooding function - initiated from idleMessageRouter
function initiateDownloadFlooding(
  socket: WebSocket,
  clientState: ClientState & { status: "download" },
  requestedDurationMs: number,
  payloadSizeBytes: number
) {
  const floodStartTimeMs = performance.now();
  // this is the back pressure threshold.
  // the flood will schedule/send payload as fast as possible
  // until socket.bufferedAmount exceeds this threshold
  const backpressureThresholdBytes = 2 * payloadSizeBytes;
  const payload = new ArrayBuffer(payloadSizeBytes);

  console.log(`Starting download flood - ${payloadSizeBytes} bytes per chunk`);

  // Debounce backpressure logging - accumulate count and schedule log
  let backpressureCount = 0;
  let backpressureDebounceTimer: number | null = null;
  const BACKPRESSURE_LOG_DEBOUNCE_MS = 1000;
  // This is just for the logging, not for the throttling
  function debounceBackPressureLog() {
    // THROTTLING BEHAVIOR:
    // - First backpressure event logs immediately
    // - Subsequent events accumulate silently during throttle period
    // - After throttle period expires, next event logs immediately with accumulated count
    // - This gives immediate feedback but prevents spam

    backpressureCount++;

    // If no timer running, log immediately and start throttle period
    if (backpressureDebounceTimer === null) {
      console.log(
        `Backpressure detected - delayed ${backpressureCount} chunks`
      );

      // Reset count after logging (since we just reported it)
      backpressureCount = 0;

      // Start throttle timer - during this period we'll accumulate but not log
      backpressureDebounceTimer = setTimeout(() => {
        // Timer expired - just reset timer flag (keep accumulated count for next log)
        backpressureDebounceTimer = null;
      }, BACKPRESSURE_LOG_DEBOUNCE_MS);
    }
    // If timer is already running, we just accumulate (no logging)
  }

  //  this is the payload flooding function, it schedules itself to run again
  function sendDownloadChunk() {
    // If the downloadFloodTimer is FLOOD_CANCELLED,
    // e.g. the stop message has been received, we should terminate the flooding loop.
    if (clientState.downloadFloodTimer === FLOOD_CANCELLED) {
      console.log("Download flood timer cleared - stopping flooding");
      return;
    }

    // Check backpressure before sending - and debounce it's logging
    if (socket.bufferedAmount >= backpressureThresholdBytes) {
      // Buffer is full, schedule retry without sending
      debounceBackPressureLog();
      clientState.downloadFloodTimer = setTimeout(sendDownloadChunk, 1);
      return;
    }

    // Send payload
    socket.send(payload);

    // Check if duration + buffer has elapsed
    const elapsedMs = performance.now() - floodStartTimeMs;
    if (elapsedMs >= requestedDurationMs + DOWNLOAD_DURATION_BUFFER_MS) {
      // Flooding duration completed
      console.log(`Download flood completed - in ${elapsedMs}ms`);
      // Clear timer reference
      clientState.downloadFloodTimer = FLOOD_CANCELLED;
      return;
    } else {
      // Schedule next chunk immediately
      clientState.downloadFloodTimer = setTimeout(sendDownloadChunk, 0);
    }
  }

  // Start the flooding
  sendDownloadChunk();
}

// File serving helper
async function serveFile(
  filePath: string,
  contentType: string
): Promise<Response> {
  try {
    const content = await Deno.readTextFile(filePath);
    return new Response(content, {
      headers: { "content-type": contentType },
    });
  } catch (error) {
    logError(`Failed to serve ${filePath}`, error);
    return new Response("File not found", { status: 404 });
  }
}

// Utility function for consistent error logging
function logError(context: string, error: unknown): void {
  // @ts-ignore: Safe access to message property for error logging
  const message = error?.message || String(error) || "Unknown error";
  console.error(`${context}: ${message}`);
}
