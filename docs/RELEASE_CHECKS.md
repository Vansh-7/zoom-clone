# Release verification

Verified on October 9, 2026. Application release: `c7edd7e3bfa87c4f954cd78e624c3b713daeba51`.

## Deployment

| Platform               | Application commit | Result                                                                      |
| ---------------------- | ------------------ | --------------------------------------------------------------------------- |
| GitHub main at release | `c7edd7e`          | [CI passed](https://github.com/Vansh-7/zoom-clone/actions/runs/37894310236) |
| Vercel production      | `c7edd7e`          | Public frontend responds over HTTPS                                         |
| Railway production     | `c7edd7e`          | Deployment `a99b8c0c-68b9-47b9-b77f-ae5bb5e91913` succeeded                 |

Railway was updated from `53a71a7` after approval. Only its source branch and exact commit were changed. The existing `/data` SQLite volume, variables, domain, Dockerfile builder, health check, one worker, and one replica were preserved. No schema migration, database reset, or service recreation was performed. Capacity remains two.

Backend health, API documentation, CORS for the public frontend, calendar download, and HTTPS/WSS communication were verified. Startup logs showed one worker. Reviewed logs after acceptance testing and the controlled restart contained no application exceptions or HTTP 5xx responses. The bounded startup script and REST/WebSocket limits are now deployed; production rejected a 65,537-byte WebSocket message with close code `1009`.

The backend source is pinned to this tested commit. Future releases must explicitly select a newly tested commit. Redeploying an earlier snapshot does not update source. Documentation-only commits can differ from the deployed application commit without changing application behavior.

## Executed checks

| Check                                                    | Passed | Failed | Skipped |
| -------------------------------------------------------- | -----: | -----: | ------: |
| Local backend pytest                                     |    104 |      0 |       0 |
| Local default Chrome suite, without relay fixture        |     17 |      0 |       8 |
| Local UDP/TCP relay checks, temporary coturn fixture     |      2 |      0 |       0 |
| Local release harness validation                         |      4 |      0 |       0 |
| Production release harness                               |      4 |      0 |       0 |
| Additional production navigation/permission/start checks |      3 |      0 |       0 |
| Production media/admission repeated after restart        |      2 |      0 |       0 |
| GitHub CI backend                                        |    104 |      0 |       0 |
| GitHub CI Chrome                                         |     17 |      0 |       8 |

The default suite's eight skips are six opt-in mesh/performance cases and two relay cases. The two relay cases passed separately locally, giving 19 distinct local regression checks. Seven distinct production browser checks passed; two were repeated after restart. Larger-room experiments were not repeated and production capacity was not increased.

Ruff lint and formatting, ESLint, TypeScript, Prettier, and the Next.js production build passed. Backend pytest reported nine dependency deprecation warnings. Initial release-harness runs exposed test-selector, navigation-wait, and browser ICE-normalization mistakes; these were corrected before production testing. No application defect was reproduced, so application code was retained.

## Production evidence

- Instant creation persisted a meeting and returned a valid invitation. Joining worked by formatted ID and direct URL in separate signed-out contexts. Invalid IDs, unrelated URLs, and missing names were rejected.
- Browser scheduling persisted title, description, local time, timezone, and duration. Refresh retained the record. Downloaded `.ics` start/end timestamps matched UTC and included the invitation URL. Upcoming/Previous views and host-first scheduled admission worked.
- Both Chrome contexts had increasing inbound/outbound audio/video packet counters, decoded frames, and playing remote video. Peer configuration matched the actual deployed RTC configuration. Selected pairs were direct `host/host/udp`.
- Camera/microphone controls, native synthetic microphone selection, roster updates, leave/rejoin, refresh, host mute-all/removal/end, guest privilege rejection, and cleanup passed. Removed and invalid sessions could not authenticate.
- A synthetic canvas selected as the shared-screen source reached the other participant; stopping sharing restored camera video. Chat was delivered in both directions as plain text with participant identity.
- Deliberately unreachable candidates produced media failure while signaling stayed connected. Diagnostics omitted SDP, addresses, capabilities, and credentials. Restoring candidates and using ICE retry resumed bidirectional media.
- Back/Forward released capture and sockets before rejoining. Simulated camera/microphone denial allowed no-media admission. Simulated backend downtime showed Offline and recovered. These simulations do not prove physical permission dialogs or real network outages.
- Home, Meetings, Schedule, Join, and room screenshots were captured at 1440, 768, and 390 pixels. Horizontal overflow, mobile list/detail navigation, native select interaction, and keyboard meeting/tab selection were checked. Desktop Home, tablet Meetings, and the mobile room were visually inspected. This was not a full accessibility certification.

Before the approved controlled restart, all test calls were closed. After restart, the scheduled record retained every response field, and 58 previously saved records retained their codes and stored fields. Health recovered and media/admission checks passed again. Existing records were not removed or overwritten. New test records remain in history; no production cleanup or reset was performed.

Screenshots and sanitized RTP evidence are stored locally in ignored `artifacts/release/`. Traces are disabled in the release configuration because network traces can contain capabilities or TURN credentials.

## Repeat acceptance checks

From `frontend`, after release approval and with both target services available:

```powershell
$env:E2E_API_URL="https://zoom-clone-api.up.railway.app"
$env:E2E_FRONTEND_URL="https://zoom-clone-vansh.vercel.app"
$env:E2E_BROWSER_CHANNEL="chrome"
npm.cmd run test:e2e -- --config playwright.release.config.ts
npm.cmd run test:e2e -- tests/workflows.spec.ts --grep "Back and Forward|permission denial|guest waits" --trace off
```

The release configuration requires explicit URLs. It creates new meetings and does not claim seeded samples, delete records, reset SQLite, or override the deployed ICE configuration. Use an isolated backend for the complete default suite.

The scheduling check saves `artifacts/release/persistence-before.json`. Close test calls, obtain approval, and restart the existing backend without replacing its volume. Then run:

```powershell
node verification/check-persistence.mjs
npm.cmd run test:e2e -- --config playwright.release.config.ts --grep "deployed ICE|production admission"
```

## Remaining checks

Production still advertises STUN only. Choose a hosted TURN provider and follow [deployment and TURN procedures](DEPLOYMENT.md). Hosted UDP/TCP/TLS relay, two physical devices on different networks, audible physical microphones, real screen-picker permissions, physical device switching, long sessions, Safari/iOS/Android, and Firefox remain unverified for this release. Local coturn and two contexts on one computer do not establish cross-network reliability.

Earlier Windows Firefox tests could not launch their installed runtime; earlier WebKit workflow checks did not provide camera/microphone capture. Those results are not claimed as production media verification. Speaker selection remains managed by browser/system settings. Keep capacity two.
