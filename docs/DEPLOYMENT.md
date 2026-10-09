# Deployment

Update the existing Vercel and Railway projects. Do not recreate the backend service, reset SQLite, or replace its volume.

## Release configuration

1. Run the checks in the README and confirm GitHub CI passes for the commit being deployed.
2. In Railway, select the existing backend service and production environment. Connect `Vansh-7/zoom-clone`, branch `main`, with root directory `/backend`. Stage the exact CI-tested commit and review pending changes before approval and deployment. The current source is pinned to application release `c7edd7e`; explicitly select a new tested commit for future releases. Redeploying an old deployment can reuse its old source.
3. Preserve the Dockerfile builder, `/data` volume mount, `DATABASE_URL=sqlite:////data/zoom.db`, health check `/api/health`, and one replica. Use the existing startup script, which starts one worker with bounded WebSocket message size and queue length.
4. Set `FRONTEND_URL=https://zoom-clone-vansh.vercel.app` and `CORS_ORIGINS=https://zoom-clone-vansh.vercel.app`. Add other origins explicitly only when needed. The same allowlist protects WebSocket admission.
5. Confirm the runtime can write `/data`. Railway documents volume ownership in its [volume guide](https://docs.railway.com/volumes). Existing services may use `RAILWAY_RUN_UID=0` for this reason; preserve a working setting.
6. In Vercel, use root directory `frontend`, the Next.js preset, Node.js 22, and `NEXT_PUBLIC_API_BASE_URL=https://zoom-clone-api.up.railway.app`. Rebuild after changing this public build-time variable.
7. Keep the stable production domain public. Preview deployment protection can remain enabled.
8. Check both platforms' deployed source commits, backend startup logs, and the public health endpoint. A healthy old deployment does not prove the latest code is running.

Keep the existing database during updates. Coordinate restarts with participants because in-memory rooms and active calls end. For backups, use SQLite's online backup facility rather than copying only the main database file while WAL writes are active.

## TURN configuration

Obtain a TURN hostname, supported ports/transports, username, credential, expiry information, and quota from your provider. Add `ICE_SERVERS_JSON` to the existing Railway service using provider-issued values:

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  {
    "urls": [
      "turn:YOUR_TURN_HOST:3478?transport=udp",
      "turn:YOUR_TURN_HOST:3478?transport=tcp",
      "turns:YOUR_TURN_HOST:5349?transport=tcp"
    ],
    "username": "YOUR_TURN_USERNAME",
    "credential": "YOUR_TURN_CREDENTIAL"
  }
]
```

Use only URLs and ports supported by your provider. Some providers use TCP/TLS port 443 instead of these example ports. Do not assume a provider's STUN hostname also accepts TURN. Keep `ICE_TRANSPORT_POLICY=all` for normal operation.

1. Choose a provider and obtain its browser-compatible TURN URLs and username/password credentials. Confirm expiry, traffic quota, supported transports, and renewal rules. Credentials must remain valid for the evaluation period and new ICE allocations.
2. In Railway, open the existing `zoom-api` service, production environment, then Variables. Replace `ICE_SERVERS_JSON` with the JSON array above using the issued values. Keep the existing volume, database path, origins, replica count, and participant limit. Do not put credentials in Vercel, Git, or this document.
3. Obtain release approval before applying the variable changes and redeploying. Existing calls are interrupted. Check backend health and startup logs. In a private browser session, inspect `/api/rtc-config` and confirm it contains the expected TURN schemes and policy without saving or sharing its credential-bearing response. New connections fetch this configuration; existing peers retain their old ICE settings.
4. For each supported transport, temporarily configure exactly one TURN URL and `ICE_TRANSPORT_POLICY=relay`. Offering UDP, TCP, and TLS together can fall back to another transport and does not prove all three work. Apply the changes, then open fresh browser contexts and a fresh meeting.
5. Use two physical devices with headsets, first on Wi-Fi and then on separate Wi-Fi/mobile networks. Open `chrome://webrtc-internals` before joining. Verify the selected candidate pair uses a relay and the intended transport. On both devices, confirm increasing outbound and inbound audio/video packets, decoded video frames, visible remote video, and audible remote sound. A connected signaling indicator alone is insufficient.
6. Toggle camera/microphone, share a screen and stop sharing, retry ICE, leave/rejoin, send chat, and exercise host controls. If ICE fails, copy the application's connection diagnostics. They omit candidate addresses, SDP, tokens, and credentials. Do not share raw browser WebRTC dumps without reviewing their sensitive contents.
7. Restore all supported TURN URLs and `ICE_TRANSPORT_POLICY=all`, apply the changes, and repeat a fresh two-device meeting. Record the tested devices, browsers, networks, transports, and date. Keep `MAX_PARTICIPANTS=2`.

Browsers must receive ICE credentials to use TURN; this application's public RTC configuration returns them to meeting clients. Use provider restrictions and quotas and rotate credentials as required. Do not use an unrestricted administrative credential. Automatic issuance or renewal of short-lived TURN credentials is not implemented. See [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server).

## Proxy identity and rate limits

Railway's edge supplies `X-Real-IP`, documented in its [public networking reference](https://docs.railway.com/networking/public-networking/specs-and-limits). The application accepts that header only when the actual socket peer belongs to an explicit `TRUSTED_PROXY_CIDRS` allowlist. The same resolved identity is used by REST limits and WebSocket admission. Uvicorn's implicit forwarded-header handling is disabled, and caller-supplied `X-Forwarded-For` never selects a budget.

Leave the allowlist empty for local use. Before enabling it in Railway, confirm the edge's source range and that the edge replaces incoming `X-Real-IP`. The observed service peers during this audit were within `100.64.0.0/24`; that observation is not a documented Railway guarantee. Set that range only after confirming it applies to this service, or use the narrower confirmed IPs/CIDRs. Do not use `*`, an all-address range, or the whole shared-address space. Recheck the policy after region/network changes. No production variable was changed during this audit.

With an empty allowlist or an unrecognized edge peer, limits fall back to the socket address. This prevents header-based bypass but can make clients behind an edge share a budget. Configuration validation and tests cover empty/untrusted/duplicate/malformed headers, distinct client budgets, and matching HTTP/WebSocket identity. Production identity verification remains a release check.

## Acceptance checks

1. Open the stable frontend URL in a signed-out browser. Confirm upcoming and recent records load.
2. Create an instant meeting. Confirm the room, meeting ID, and invitation copy action work.
3. Open the invitation in a separate browser context, enter another display name, and join. Also test joining by formatted ID and reject an invalid ID.
4. Enable both cameras and microphones. Check remote playback and bidirectional inbound/outbound RTP. Test mute, camera toggle, ICE retry, and leaving/rejoining.
5. Test screen sharing and camera restoration, meeting chat, host mute-all, removal, guest authorization rejection, and ending for everyone.
6. Schedule a future meeting, refresh, and download its calendar invitation. Verify its date, time, duration, and join URL in a calendar application.
7. Record the scheduled meeting's code and fields. Restart the existing backend service, preserving its volume, then retrieve the same record and compare it. Check health and logs again.
8. Check navigation, Back/Forward, page refresh, backend downtime messages, and layouts at 1440, 768, and 390 pixels. Confirm leaving a page releases camera/microphone tracks and WebSockets.

Repeat media checks with physical devices on the intended networks. Synthetic browser tests and a local TURN fixture verify application behavior, but do not verify a hosted relay, device drivers, or network firewalls.

Public REST endpoints use bounded in-memory token buckets with separate budgets for creation, joining, claiming samples, reads, and host actions. Excess traffic receives `429` with `Retry-After`. Health checks, CORS preflight, and participant leave requests remain available. Users behind a shared public IP can share a budget even with correctly configured proxy identity.

Dependency check on October 9, 2026: `npm audit --omit=dev` reports zero vulnerabilities. The full audit reports five high-severity entries in the ESLint dependency chain, originating from [the braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No patched braces version is available. Keep lint inputs limited to the trusted repository and recheck for an upstream fix; a forced downgrade of Next.js tooling was not applied.
