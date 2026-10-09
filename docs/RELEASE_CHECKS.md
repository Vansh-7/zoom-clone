# Reliability and release checks

## Deployment audit

Read-only checks on October 9, 2026 found:

| Source             | Commit                                     | Status                              |
| ------------------ | ------------------------------------------ | ----------------------------------- |
| GitHub `main`      | `d68a3ed015b58135155aa41bda6759f247bacca6` | Current remote source at audit time |
| Vercel production  | `d68a3ed015b58135155aa41bda6759f247bacca6` | Ready, public application available |
| Railway production | `53a71a7d08b0682767cb1a041e98908fca79f6a3` | Healthy, behind GitHub              |

The existing Railway service has its SQLite volume mounted at `/data`, one replica, and a Dockerfile build rooted at `/backend`. Health was OK; reviewed runtime logs contained no errors. Public RTC configuration advertised two participants, normal ICE policy, and STUN only. No deployment or production configuration change was performed, and no database reset was requested. Local changes require approval before publication or deployment.

The deployed calendar download returned HTTP 404, and the old source snapshot lacks the current bounded startup script and REST/WebSocket limit modules. This confirms a real release gap; public health alone does not establish frontend/backend feature compatibility. Updating the existing backend is required before final submission. SQLAlchemy models and database schema are unchanged relative to that deployed source, so this release requires no schema migration.

## Changes and evidence

- Signaling and peer media transport have separate status labels. A connected WebSocket can coexist with failed ICE without a green media indicator. A solo host sees a waiting state. The failure/retry test checks both labels.
- Prejoin lists camera and microphone inputs through `enumerateDevices`. Selection uses an exact device ID. A successful replacement retains the other input and mute state; a failed replacement leaves the existing input live. Device changes refresh the list. Late capture results are stopped after cancellation, navigation, or meeting termination.
- Native select controls support keyboard navigation. Browser tests cover replacement failure, permission denial, removed devices, mobile overflow, selected tracks reaching the call, real synthetic RTP, and capture cleanup. Input aliases in the switching fixture represent two choices backed by native synthetic capture; physical hardware selection remains untested.
- WebKit reproduced topic input being cleared during initial hydration. Scheduling inputs now wait for browser timezone initialization before accepting edits. An unavailable capture API has an explicit message and still allows joining without media.
- Mobile screenshots exposed two participant tiles collapsing to their placeholder content height. Grid rows now divide the available canvas height. The two-party device test also checks usable tile height at 390 pixels.
- Trusted proxy identity is explicit and shared by REST limiting and WebSocket admission. Tests reject untrusted, forged, duplicate, and malformed forwarded identity. No new infrastructure or authorization cache was added.
- The existing offer ownership, serialized signaling, generation-aware ICE queue, restart path, and peer teardown were retained. No new negotiation defect was reproduced. Local direct and UDP/TCP relay tests passed with the updated capture hook.
- Four-person measurement runs passed twice per profile, with adaptation and ICE recovery tested separately. Browser downscaling limits the interpretation of the 720p results. See [mesh measurements](MESH_VERIFICATION.md).

Backend: **104 pytest tests passed**, with nine existing dependency deprecation warnings. Ruff lint and formatting passed. At the two-person limit, **19 Chrome Playwright tests passed**, including two local relay tests; six mesh/performance cases skipped intentionally. Separately, three mesh workflow cases and six performance runs passed at capacity four.

Frontend lint, type checking, formatting, and production build passed. Nine existing workflow checks also passed in Windows Playwright WebKit, covering calendar export, scheduling/timezones, joining, keyboard tabs, 1440/768/390 layouts, backend errors, and no-media admission. This WebKit runtime has no `getUserMedia`; its no-media check verifies the unsupported-API path. It does not verify Safari or WebKit audio/video.

Firefox's nine attempted checks failed before application assertions because its installed test runtime could not launch (`spawn UNKNOWN`; Windows reported a `mozglue` side-by-side assembly error). Firefox compatibility remains unverified. No Windows security setting or application dependency was changed to work around it. Reinstall the pinned browser on a working test machine and rerun:

```powershell
cd frontend
npx.cmd playwright install firefox webkit
npm.cmd run test:e2e -- --config playwright.compatibility.config.ts
```

Use the same isolated backend and URL overrides as the main suite. [Playwright's browser documentation](https://playwright.dev/docs/browsers) explains the differences between its patched engines and branded Safari/Firefox. The separate config reuses existing workflow tests and removes Chromium-specific capture flags and permissions.

A scheduled SQLite record retained its code, title, description, timestamp, duration, status, and invitation across an isolated local backend restart. Production restart persistence remains untested for this release.

Prejoin and meeting-room screenshots were captured at 1440, 768, and 390 pixels. The mobile canvas fix was visually inspected, and the README meeting-room screenshot was refreshed from the final local production build.

## Changed files

| Area                     | Files                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Proxy configuration      | `backend/.env.example`, `backend/app/config.py`, `backend/app/main.py`, `backend/app/server.py`, `backend/app/proxy.py`                                                                          |
| Backend regression tests | `backend/tests/test_proxy.py`, `backend/tests/test_websocket_transport.py`                                                                                                                       |
| Media and status UI      | `frontend/hooks/use-local-media.ts`, `frontend/components/meeting-room.tsx`, `frontend/components/device-selectors.tsx`, `frontend/components/connection-status.tsx`, `frontend/app/globals.css` |
| Hydration guard          | `frontend/components/meeting-forms.tsx`                                                                                                                                                          |
| Browser verification     | `frontend/tests/devices.spec.ts`, `frontend/tests/rtc.spec.ts`, `frontend/tests/workflows.spec.ts`, `frontend/tests/mesh-performance.spec.ts`, `frontend/playwright.compatibility.config.ts`     |
| Documentation            | `README.md`, `docs/DEPLOYMENT.md`, `docs/MESH_VERIFICATION.md`, `docs/RELEASE_CHECKS.md`                                                                                                         |

The refreshed image is `docs/screenshots/meeting-room.png`.

## Publish the tested release

1. Review the local commits and obtain approval before pushing to GitHub. Pushing `main` can trigger Vercel automatically. Run GitHub CI for the exact published commit.
2. In the existing Railway production service, stage source `Vansh-7/zoom-clone`, branch `main`, root `/backend`, selecting the exact tested commit. Do not redeploy the old deployment's source snapshot. Review changes before applying them.
3. Preserve the `/data` volume, database path, existing variables, Dockerfile/startup script, health check, one worker/replica, and capacity two. Configure trusted proxy identity only after verifying the edge policy described in [deployment instructions](DEPLOYMENT.md).
4. Obtain approval to apply the staged backend deployment. Coordinate with active participants because a restart ends calls. Check the deployed commit, health, startup logs, and volume mount afterward.
5. Confirm Vercel uses the same tested commit, the existing public domain, and its existing HTTPS API origin. Verify direct invitations and WSS signaling between the two releases.
6. Run the deployment acceptance checklist. Record a scheduled meeting before a backend restart, then retrieve the same code and fields afterward to verify persistence. Local tests do not substitute for this production check.

## Remaining manual checks

Choose a hosted TURN provider and configure issued credentials directly in Railway. Follow the per-transport, relay-only two-device procedure in [deployment instructions](DEPLOYMENT.md), then restore normal ICE policy. Hosted TURN, TLS relay, physical cameras/microphones, cross-network calls, long sessions, real Safari/iOS/Android permissions, and physical input switching remain unverified.

Speaker selection is deferred; output follows browser/system settings. Meeting editing and cancellation are deferred because they are outside the mandatory assignment workflows. Production capacity stays at two until separate physical-device and network verification supports a change.
