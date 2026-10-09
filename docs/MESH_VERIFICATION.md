# Mesh capacity verification

The production participant limit remains **two**, confirmed through the public backend on October 9, 2026. The separate mesh experiments below did not change production settings or infrastructure. The public backend advertises STUN only. See [release verification](RELEASE_CHECKS.md) for the subsequent backend deployment and production checks.

## Implementation and fix

Each browser maintains one `RTCPeerConnection` for each remote participant. Three people create three peer pairs; four create six. The lower participant ID creates the offer for each pair. Offers, answers, and ICE candidates travel through the existing room-scoped FastAPI WebSocket; media travels between peers or through the configured TURN relay.

Signaling handlers are serialized, ICE candidates are matched to their description's generation, and leaving closes the departed participant's peer connections. Media track replacement applies to every peer sender. Host commands retain server-side session and role validation. SQLAlchemy models, the RoomManager architecture, and the single-worker deployment are unchanged.

The audit reproduced one application bug: connecting a healthy third participant cleared the displayed error for another failed peer. The frontend now clears that error only when all remaining peer connections are healthy, or after the failed participant leaves. A test blocks a real pair's ICE candidates, joins a healthy third participant, checks the error remains visible, then verifies recovery after the failed participant leaves.

## Verified scope

Local Chrome tests on October 9, 2026 used separate browser contexts, synthetic microphone audio, 640×360 camera capture at up to 15 fps, and an animated synthetic screen source. These use real peer connections and RTP, with no simulated connection success.

- Three- and four-person workflows passed twice each. The failed-peer error test also passed twice.
- The complete four-person workflow also passed with relay-only ICE through a disposable local coturn fixture, once over UDP and once over TCP. All twelve peer connections selected relay candidates and carried media. This does not verify a hosted TURN provider or a different network.
- Every participant had exactly `N-1` live peer connections and a complete roster. Every pair reached stable signaling and connected media, with increasing inbound/outbound audio/video packet counters and decoded video frames.
- Remote video elements rendered frames and played. All guests joined concurrently after the host.
- Concurrent ICE restart requests changed ICE credentials and restored media on every pair.
- Host screen sharing reached every guest, including a guest joining during sharing. Microphone tracks stayed unchanged; stopping sharing restored the camera on every sender.
- Chat from every participant reached the others with server-assigned identity. Host mute-all disabled guest audio tracks; explicit unmute and camera toggles continued working.
- Guest attempts to mute all, remove the host, or end the meeting were rejected. Host removal and end-for-everyone worked.
- Leaving/rejoining preserved the remaining pairs. An abruptly closed guest context did not end other participants' media. End, leave, and removal released peer connections, media tracks, and sockets.
- Backend tests cover concurrent admission at capacities three and four, full-room rejection, all pairwise signaling routes, chat identity, host checks, and persisted participant cleanup.

The latest regression run passed 104 backend tests, Ruff lint/formatting, and 19 Chrome Playwright tests at capacity two, including local UDP/TCP relay checks. The three mesh workflow tests and three opt-in performance tests skip at that limit. The mesh workflows passed separately at capacity four. Frontend checks and release details are recorded in [release checks](RELEASE_CHECKS.md).

## Capture quality and recovery measurements

On October 9, 2026, an isolated four-person backend and four Chrome contexts ran each profile twice. No production setting changed. Each run verified all twelve directional peer endpoints with increasing audio/video packets and decoded frames. The measurement window was five seconds per phase; these are short local observations, not a capacity benchmark.

| Test profile                                    | Observed outbound video                                                                             | Mean decoded fps per endpoint | ICE restart recovery          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- |
| 1280×720 capture, requested 30 fps              | Chrome downscaled many senders to 320×180, 480×270, or 640×360; some reached 1280×720 after restart | About 20                      | 255 and 260 ms                |
| 640×360 capture, capped at 15 fps               | 640×360 on every sender                                                                             | About 15                      | 234 and 241 ms                |
| 720p capture reduced to 360p/15 during the call | 480×270 or 640×360 after reduction                                                                  | About 15 after reduction      | Tested without an ICE restart |

Chrome reported `qualityLimitationReason=bandwidth` on the twelve high-capture senders, and `none` on the dedicated 360p senders. Mean encoding time after restart was approximately 5.4–7.6 ms per frame for the high-capture runs and 3.8 ms for 360p. Fake camera capture did not deliver sustained 30 fps encoding. The earlier high-capture stall did not recur in these runs, but its original cause remains unproven.

The adaptive experiment used `MediaStreamTrack.applyConstraints` on existing camera tracks. All peer endpoints continued carrying audio/video and their ICE credentials stayed unchanged. It did not change the application, replace tracks, or renegotiate. Short samples did not show a consistent bitrate decrease after adaptation. Browser congestion control already adapted sender resolution, so automatic application adaptation was deferred. Production still requests its existing camera quality and remains limited to two participants.

To reproduce the measurements on the separate four-person backend, use the setup below, then run:

```powershell
$env:E2E_MESH_PERFORMANCE="1"
npm.cmd run test:e2e -- tests/mesh-performance.spec.ts --repeat-each=2
Remove-Item Env:E2E_MESH_PERFORMANCE
```

The harness writes sanitized measurements to ignored `artifacts/mesh-performance-*.json` and Playwright attachments. It excludes SDP, candidate addresses, tokens, and relay credentials. The quality tests exercise concurrent ICE restart requests; the adaptive test isolates capture changes from ICE recovery. It uses direct local ICE and does not establish cross-network performance.

## Reproduce locally

Use the normal installation instructions first. Run a separate backend from `backend`:

```powershell
$env:MAX_PARTICIPANTS="4"
$env:DATABASE_URL="sqlite:///./data/mesh-test.db"
$env:FRONTEND_URL="http://127.0.0.1:3100"
$env:CORS_ORIGINS="http://127.0.0.1:3100,http://localhost:3100"
.\.venv\Scripts\python.exe -m app.server --host 127.0.0.1 --port 8002
```

In a second terminal, from `frontend`:

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8002"
npm.cmd run build
npm.cmd run start -- --port 3100
```

In a third terminal, from `frontend`:

```powershell
$env:E2E_API_URL="http://127.0.0.1:8002"
$env:E2E_FRONTEND_URL="http://127.0.0.1:3100"
npm.cmd run test:e2e -- tests/mesh.spec.ts --repeat-each=2
```

Mesh tests skip when the backend's advertised capacity is too small. They never change server capacity. Default runs use direct local ICE without STUN. For relay-only checks, set `E2E_RTC_CONFIG_FILE` to an ignored local JSON file containing `ice_servers` and `ice_transport_policy: "relay"`. Use one TURN transport per run. The tests assert the selected local candidate is a relay and verify media on every pair. Keep credentials out of Git and delete temporary fixtures after use. Provider configuration is described in [deployment instructions](DEPLOYMENT.md).

Restore `MAX_PARTICIPANTS=2`, restart the local backend, and run the complete Playwright suite to check the two-person experience. Restore the frontend's normal API configuration before rebuilding for regular use.

## Limits and remaining checks

- The complete three/four-person workflow was verified at 360p/15 fps. Higher-capture measurement runs recovered locally, with browser downscaling; sustained four-person 720p/30 fps delivery and the earlier stall remain unresolved. Application capture settings were not changed to make tests pass.
- Tests used one computer and short sessions. Physical cameras, speakers, different browsers, long calls, hosted TURN, and cross-network media were not verified. Synthetic packet flow does not prove audible sound or device-driver behavior.
- Mesh upload, encoding, and decoding cost grows with participant count. Each browser sends its media to every other participant. This audit does not establish support for five or six people.
- Screen sharing replaces the camera video track and leaves microphone audio intact. Concurrent presenters and shared-system audio were not verified.

Before raising production capacity, repeat the full workflow in a test environment configured for four participants, using three/four physical devices, first on the intended Wi-Fi and then across Wi-Fi/mobile networks. Use headsets, verify each participant receives every other participant's audio/video, and inspect every pair's selected ICE candidates and RTP counters. Repeat with relay-only TURN over the provider's supported UDP, TCP, and TLS transports; then restore normal ICE policy. Test repeated joins/leaves, sharing, ICE retry, host controls, and a longer call at the desired video quality. Keep the production limit at two until that verification and an explicit capacity-change decision are complete.
