# Conferencing verification

Production supports two participants. Four participants are tested only on an isolated backend with its own SQLite file. This document records synthetic browser evidence and the remaining release gates.

## Capacity acceptance criteria

For four participants, each browser must have three connected peer connections, giving six pairs and twelve directional endpoints. All endpoints must send and receive audio/video, decode increasing frames, and render remote video. Concurrent joins and ICE restarts must complete without signaling errors. Sharing must reach every guest and restore the camera. Chat, mute controls, host authorization, removal, leave/rejoin, and end-for-everyone must work. Leaving, removal, navigation, and ending must release tracks, sockets, and peer connections.

The automated workflow checks these conditions at 640 x 360 capture, capped at 15 fps. Measurements compare 1280 x 720 capture at a requested 30 fps, 360p/15 fps, and reducing an existing camera track to 360p/15 fps without replacing tracks or restarting ICE. The performance harness verifies increasing media counters across every endpoint during each observation interval. These short observations are not a sustained-load benchmark.

Before raising production capacity, also require four physical devices on separate networks, hosted relay verification over UDP, TCP, and TLS, and a 30-minute call at the intended quality. Every participant must hear and see every other participant, with acceptable device temperature, CPU use, and upload bandwidth. Repeat joins/leaves, sharing, recovery, and host controls. Production remains at two until these checks and explicit approval are complete.

## Results on October 9, 2026

Audited GitHub/Vercel commit: `60a1587`. Railway: `c7edd7e`, healthy, one worker/replica, existing `/data` volume. Application code is identical between these commits; subsequent changes were tests and documentation. No backend deployment, restart, production variable, database reset, or capacity change was performed during this audit. Publishing these verification and documentation changes triggers the existing Vercel deployment after approval.

| Check                                                                                                                                  | Result                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Backend pytest, including proxy identity, REST/WS limits, revoked sessions, host authorization, transport size limits and mesh routing | 104 passed, 0 failed, 0 skipped; 9 dependency deprecation warnings         |
| Ruff lint and formatting                                                                                                               | Passed; 27 files formatted correctly                                       |
| Local two-person Chrome suite, including device selection and local UDP/TCP relay                                                      | 19 passed; 7 isolated mesh/performance cases skip at capacity two          |
| Isolated mesh workflow and failure/recovery cases, repeated twice                                                                      | 8 passed                                                                   |
| Four-person full workflow through local relay, UDP and TCP separately                                                                  | 2 passed; selected relay candidates on all twelve endpoints                |
| Four-person quality measurements, three profiles repeated twice                                                                        | 6 passed; two 30-second samples per run                                    |
| Windows WebKit workflows and 1440/768/390 layouts                                                                                      | 9 passed; media APIs unavailable in this engine                            |
| Firefox launch check                                                                                                                   | 1 failed before application assertions; Windows side-by-side runtime error |
| Deployed Chrome acceptance tests                                                                                                       | 4 passed, using synthetic inputs and the actual deployed ICE configuration |
| Frontend lint, typecheck, formatting and production build                                                                              | Passed                                                                     |
| GitHub CI for audited `60a1587`                                                                                                        | Passed; rerun CI for any subsequently published verification changes       |

Production checks covered instant creation, ID/direct invitation admission, name/existence validation, scheduling, calendar export, upcoming/previous views, responsive navigation, bidirectional RTP and remote rendering, device selection, sharing/restoration, chat, host permissions, mute/removal/end, leave/rejoin, refresh, ICE failure/retry, revoked sessions and oversized WebSocket rejection. Public application/API/repository links returned HTTP 200. CORS accepted the exact frontend origin and rejected an unrelated origin. HTTPS/WSS worked. Test records were added without altering existing records. Persistence across a production restart was not retested because no restart was authorized for this audit.

The corrected WebKit rerun passed after the calendar test was changed to wait for hydrated API rows and select its own meeting. An earlier run selected another meeting and failed. A final Chrome run exposed an existing pending-camera test race: it expected the ended screen instead of the host's Home navigation. The corrected assertion verifies Home, persisted ended status, and late capture cleanup. The new multi-failure test initially used an incorrect button label; corrected repeated runs passed. No application-side negotiation defect was reproduced. Firefox remains blocked rather than counted as passing.

### Four-person measurements

Chrome used four contexts on one Windows computer with 20 logical cores. Each browser sent video to three peers. All twelve directional endpoints carried increasing audio/video packets and decoded frames in every sample.

| Capture profile                             | Mean decoded fps per endpoint | Mean video upload per browser   | Browser CPU, all four contexts                | Mean encoding time per frame    |
| ------------------------------------------- | ----------------------------- | ------------------------------- | --------------------------------------------- | ------------------------------- |
| 1280 x 720, requested 30 fps                | 19.9 to 20.0                  | 1.21 to 1.96 Mbps               | 5.57 to 7.79 core equivalents                 | 8.27 to 16.20 ms                |
| 640 x 360, capped at 15 fps                 | 14.9 to 15.0                  | 0.45 to 0.47 Mbps               | 3.19 to 3.42 core equivalents                 | 3.67 to 4.05 ms                 |
| Existing 720p camera reduced to 360p/15 fps | About 14.9 after reduction    | About 0.45 Mbps after reduction | 3.18 to 3.25 core equivalents after reduction | 3.64 to 3.75 ms after reduction |

Concurrent ICE restarts recovered in 206 to 365 ms on the local direct path. The new failure test corrupted candidates for all three host pairs: guest-to-guest media continued, failed media remained distinct from connected signaling, and retry recovered all pairs. Local relay workflows also verified sharing, chat, controls and cleanup. Screen sharing used a canvas stream as the selected display, with real track replacement and remote decoding; native screen-picker permissions were not exercised.

The longer high-capture runs delivered 720p at about 20 fps, without reproducing the earlier stall. They do not establish sustained 720p/30 fps or cross-network recovery. Reducing capture saved CPU and upload bandwidth without changing ICE credentials or audio tracks. Automatic production adaptation was deferred because the evidence comes from one host and synthetic inputs. The existing two-person experience and capture settings remain unchanged.

## Repeat the isolated checks

Install dependencies using the README. From `backend`, run:

```powershell
$env:MAX_PARTICIPANTS="4"
$env:DATABASE_URL="sqlite:///./data/mesh-test.db"
$env:FRONTEND_URL="http://127.0.0.1:3100"
$env:CORS_ORIGINS="http://127.0.0.1:3100,http://localhost:3100"
.\.venv\Scripts\python.exe -m app.server --host 127.0.0.1 --port 8002
```

From `frontend`, in a second terminal:

```powershell
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8002"
npm.cmd run build
npm.cmd run start -- --port 3100
```

From `frontend`, in a third terminal:

```powershell
$env:E2E_API_URL="http://127.0.0.1:8002"
$env:E2E_FRONTEND_URL="http://127.0.0.1:3100"
npx.cmd playwright test tests/mesh.spec.ts --repeat-each=2
$env:E2E_MESH_PERFORMANCE="1"
$env:E2E_MESH_SAMPLE_SECONDS="30"
npx.cmd playwright test tests/mesh-performance.spec.ts --repeat-each=2
```

The measurement reports are written to ignored `artifacts/mesh-performance-*.json`. They contain frame rates, video bitrate per endpoint, encoding time, resolution, quality limitation reason, and browser CPU consumption. CPU uses cumulative process time from Chromium CDP, summed across processes present at both sample boundaries. One core equivalent means one fully occupied logical core. This measures four browser contexts on one machine; it excludes other processes, new/exited processes, hardware codec load, and remote physical devices.

The default mesh/performance tests use direct local ICE. Relay workflow tests accept `E2E_RTC_CONFIG_FILE` containing `ice_servers` and `ice_transport_policy: "relay"`. Use one transport per file and keep fixtures ignored. Relay fixtures disable saved network traces. Restore local capacity to two and rebuild with the normal API origin before regular use.

## Hosted TURN setup

The public backend currently advertises STUN only. Direct media may fail through restrictive NAT, isolated Wi-Fi, or firewalls. A connected WebSocket proves signaling is available; it does not prove a working media path. See the [WebRTC TURN guide](https://webrtc.org/getting-started/turn-server).

1. Choose a hosted TURN service with browser-compatible username/password credentials, UDP and TCP listeners, and a TLS listener with a valid public certificate. Use the exact hostname and ports supplied by the provider. Common ports are 3478 for UDP/TCP and 5349 or 443 for TLS; support varies by provider.
2. In the existing Railway `zoom-api` service, open the production Variables tab. Prepare `ICE_SERVERS_JSON` using the structure below. Replace the placeholders directly in Railway. Do not put the provider API key or shared signing secret in this variable. Use restricted, revocable credentials intended for browser clients, with provider quotas and an expiry that covers the call.

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": [
      "turn:TURN_HOST:3478?transport=udp",
      "turn:TURN_HOST:3478?transport=tcp",
      "turns:TURN_HOST:5349?transport=tcp"
    ],
    "username": "PROVIDER_USERNAME",
    "credential": "PROVIDER_BROWSER_CREDENTIAL"
  }
]
```

3. Keep `ICE_TRANSPORT_POLICY=all`, `MAX_PARTICIPANTS=2`, the `/data` volume, `DATABASE_URL`, origins, domain, worker, and replica unchanged. Obtain approval before applying variables or redeploying because active calls are interrupted.
4. After the approved deployment, join from two physical devices on different networks. Verify increasing inbound/outbound RTP, visible remote video, audible speech, sharing and camera restoration, chat, and retry. The copied diagnostics contain candidate types and transport state, without candidate addresses, SDP, or credentials. They must distinguish signaling from media.
5. Verify each relay transport separately using an ignored fixture with exactly one provider URL and `ice_transport_policy: "relay"`. UDP uses `turn:TURN_HOST:3478?transport=udp`; TCP uses `turn:TURN_HOST:3478?transport=tcp`; TLS uses `turns:TURN_HOST:5349?transport=tcp`. Substitute the provider's actual ports. Do not use `https://` URLs or bypass TLS certificate validation.

For a provider fixture containing UDP only, run from `frontend`:

```powershell
$env:E2E_API_URL="https://zoom-clone-api.up.railway.app"
$env:E2E_FRONTEND_URL="https://zoom-clone-vansh.vercel.app"
$env:E2E_RTC_CONFIG_FILE="D:\path-to-ignored-fixture\turn-udp.json"
npx.cmd playwright test tests/rtc.spec.ts --grep "relay-only udp"
```

Repeat with a TCP-only fixture and `--grep "relay-only tcp"`, then a TLS-only fixture with the same TCP test selector. The test requires selected relay candidates and actual received audio/video packets at both browsers. This overrides ICE only in the test browsers, without changing server capacity or normal clients. Repeat the physical-device procedure using relay-only configuration in a separate staging environment. Delete private fixtures when finished. Never attach network traces containing capabilities or TURN credentials to public issues.

## Proxy and browser limits

Railway documents `X-Real-IP` and `X-Forwarded-Proto`, but its public networking documentation does not guarantee the socket peer CIDRs for this service. `TRUSTED_PROXY_CIDRS` is not configured in production. Forwarded identity is therefore ignored, and requests share limits by upstream socket peer. Global and connection-level limits still apply; this can cause shared rate budgets under load. Do not trust the entire private address space or infer a permanent range from a few log entries. Confirm the service's ingress peers, header replacement behavior, and network isolation with Railway before proposing an allowlist. [Railway networking reference](https://docs.railway.com/networking/public-networking/specs-and-limits).

Chromium synthetic media tests do not verify physical microphones, speakers, drivers, mobile permissions, or cross-network connectivity. Windows Playwright WebKit lacks media APIs on this host, so workflow/layout checks do not establish Safari audio/video support. The installed Firefox engine fails before application assertions with a Windows side-by-side runtime error. Run compatibility tests on a host where the pinned Playwright browsers launch, and test Safari/iOS and Android on real devices. [Playwright browser reference](https://playwright.dev/docs/browsers).
