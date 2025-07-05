# WiPerf - WebSocket Throughput Tester

## Overview

A WebSocket-based network throughput tester that measures upload and download speeds between browser and server. Built with Deno TypeScript server and vanilla JavaScript client.

## Usage

For local development, run the server with:

```bash
# typescript on the fly transpilation needs: `-allow-env --allow-write`
deno run --watch --allow-net --allow-read --allow-env --allow-write server.ts
# then to view in your browser
open http://localhost:8000/
```

## Architecture

- Server: Deno TypeScript (`server.ts`) - handles WebSocket connections and test coordination
- Client: Vanilla JavaScript (`client.ts`) - transpiled on-the-fly by Deno
- Protocol: WebSocket with JSON control messages and binary payload data

## How Tests Work

Solutions to flawed assumption (see below) for both upload and download:

- Start the clock on first data-byte, not on the control message.
- Throw that first frame away —  optionally make it a 1-byte “sync” message.
  - From frame #2 onward, treat traffic as steady state.

### Upload Test (Client → Server)

- Client: Initiates by sending `startUpload:duration` message to server
  - Immediately begins flood loop sending payloads as fast as possible
- Server: on receipt of `startUpload`
  - Records `startTimeOnServerMs`
  - Resets `bytesReceived` to 0
  - On each payload received
    - accumulate bytesReceived, calculates throughput and sends `progress` message
  - Termination: when elapsed>duration, send back a final throughput `result`
- Client: Updates display on each progress message received
  - Termination when a `result` message is received
- Timing Authority: Server (receives the data)

Flawed assumption: time between sending `startUpload` and first PAYLOAD is ZERO

### Download Test (Server → Client)

- Client: Initiates by sending `startDownload:duration:payloadSize` message to server
  - Records `downloadStartTimeClient` when transitioning to download state
- Server: on receipt of `startDownload`
  - Records `startTimeOnServerMs` (non-authoritative time)
  - Begins flood loop sending payloads as fast as possible
  - On each payload sent, checks backpressure and continues flooding
  - Termination: when elapsed>duration(+epsilon), stops flooding
- Client: On each payload received
  - accumulate `downloadBytesReceived`, calculates own throughput
  - Updates display with client-calculated speed
  - Termination when elapsed>duration, sends `stopDownload` to server
- Server: on receipt of `stopDownload`
  - Sends dummy `result` message to trigger client UI reset
- Timing Authority: Client (receives the data)

Flawed assumption: time to transmit startDownload to server, and initiate flooding is ZERO.

## Key Design Principles

### Timing Architecture

- Single Clock Measurement: Each test uses one clock (server for upload, client for download)
- Receiver Authority: The side receiving data has authoritative timing
- No Clock Mixing: Never combine timestamps from different machines

### State Management

Client States:

- `disconnected` - No WebSocket connection
- `ready` - Connected, ready to test
- `upload` - Running upload test
- `download` - Running download test
- `error` - Connection or test failure

Server States:

- `idle` - No active test
- `upload` - Receiving data from client
- `download` - Sending data to client

### Flow Control

- Backpressure Monitoring: Both sides check websocket's`bufferedAmount` before sending
- Natural Throttling: Pause sending when buffer exceeds threshold
- Resume: Continue sending when buffer drains below threshold

## Protocol Messages

### Control Messages (JSON)

Client → Server:

- `{ type: "startUpload", durationMs: 3000 }`
- `{ type: "startDownload", durationMs: 3000 }`
- `{ type: "stopUpload" }`
- `{ type: "stopDownload" }`

Server → Client:

- `{ type: "progress", speed: 1234567, bytes: 98765, progressPercent: 50 }`
- `{ type: "result", speed: 1234567, bytes: 98765 }`

### Payload Messages (Binary)

- Upload: Client sends ArrayBuffer chunks to server
- Download: Server sends ArrayBuffer chunks to client

## Test Completion Flow

### Manual Stop

1. User clicks "Stop Test"
2. Client sends stop message to server
3. Server sends result message back
4. Client transitions to ready state
5. UI resets after 2 seconds

### Timer Expiration

1. Timer expires (server for upload, client for download)
2. Same flow as manual stop - send stop message to server
3. Server sends result message back
4. Client transitions to ready state
5. UI resets after 2 seconds

## Current Status

Complete:

- WebSocket protocol with Action-based wire format
- Upload/download test implementation
- Backpressure handling
- State machine with proper transitions
- UI with real-time speed display
- Theme switching (light/dark/system)
- Connection management and error recovery
