# WebSocket Throughput Tester - Task List

## Execution Rules

- Tasks are executed in order, top to bottom
- When starting a task the LLM should confirm how it will go about it
- Do not start a task until the previous one is marked complete / ie. approved by the user
- Only the user approves tasks as done with [x]
- Assistant waits for explicit approval before proceeding

## Tasks

- [x] Use performance.now() for timing - everywhere
- [x] Treat the PAYLOAD flow as steady state
  - Start/Reset the clock after the first PAYLOAD arrives.
  - [x] server - uploadData handler
  - [x] client - handlePayloadMessage
- [x] make sure duration and payload size are under client/protocol control
- [x] console logging : debug/error/info
- [x] make sure logging,duration and payload size are under UI control
- [x] Download test completed is printed, but no result message is received after stopDownload?
- [x] check units for progress/result messages
- [ ] refactor client handlePayloadMessage - just unwieldy
- [ ] Units: make sure all units are precise in name MS, Bytes, bps, etc
- [ ] o3 - two level pump! below
- [ ] optionally make the first payload smaller

Goal: keep the socket's send-buffer "comfortably full" so the NIC never
Goal: keep the socket’s send-buffer “comfortably full” so the NIC never

| Constant           | Why that value                                                                                                    |
|--------------------|-------------------------------------------------------------------------------------------------------------------|
| PAYLOAD (4 MiB)    | Big enough that `ws.send()` is called only \~200×/s even at multi-gig speeds → minimal JS overhead.               |
| HIGH = 2 × PAYLOAD | Guarantees *at least* one full payload is already in the kernel queue while the event loop prepares the next one. |
| LOW  = 1 × PAYLOAD | We don't resume until the queue has drained below one payload, so we avoid a rapid "pause-unpause" saw-tooth.     |

```bash

const MiB = 1024 * 1024;

const PAYLOAD = 4 * MiB;       // one 4 MiB ArrayBuffer, reused forever
const HIGH    = 8 * MiB;       // pause when buffered ≥ 8 MiB
const LOW     = 4 * MiB;       // resume when buffered < 4 MiB

function pump() {
  /* 1. Flood phase – as long as we haven’t hit HIGH,
        keep pushing frames back-to-back. */
  while (socket.readyState === WebSocket.OPEN &&
         socket.bufferedAmount < HIGH) {
    socket.send(PAYLOAD);      // no allocation; same buffer each time
  }

  /* 2. Drain phase – decide how to wait before flooding again. */
  if (socket.bufferedAmount >= LOW) {
    /* Still ≥ 4 MiB queued → let the kernel/NIC work for a bit.
       We arm ONE timer; when it fires we’ll re-enter pump(). */
    downloadFloodTimer = setTimeout(pump, 1);   // 1 ms pause
  } else {
    /* Buffer has dropped below LOW almost instantly (fast link).
       queueMicrotask schedules pump() for the very next JS micro-task—
       essentially “run again as soon as this stack unwinds”, with
       **zero** clamped delay and no extra timers. */
    queueMicrotask(pump);
  }
}
```

- [ ] Integration
  - [ ] Connect UI to real measurements
  - [ ] Real-time speed updates
  - [ ] Progress tracking from actual data
  - [ ] Test result history
  - [ ] Final polish and optimization

- [ ] Validation
  - [ ] iperf3 comparison testing
  - [ ] Cross-browser compatibility
  - [ ] Mobile device testing
  - [ ] Performance optimization
  - [ ] Documentation updates
