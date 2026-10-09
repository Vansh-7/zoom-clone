# Deployment

Update the existing Vercel and Railway projects. Do not recreate the backend service, reset SQLite, or replace its volume.

## Release configuration

1. Run the checks in the README and confirm GitHub CI passes for the commit being deployed.
2. In Railway, select the existing backend service and production environment. Connect `Vansh-7/zoom-clone`, branch `main`, with root directory `/backend`. Redeploying an old deployment can reuse its old source; check the source commit explicitly.
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

Use only URLs and ports supported by your provider. Keep `ICE_TRANSPORT_POLICY=all` for normal operation. Redeploy, then check `/api/rtc-config` without copying credentials into logs, screenshots, or Git.

To verify the relay, temporarily use `ICE_TRANSPORT_POLICY=relay`, start a fresh two-person meeting, and inspect the selected candidate pair and inbound/outbound RTP in `chrome://webrtc-internals`. Both participants must receive audio and decoded video frames. Test each supported transport, then restore `all` and redeploy.

Browsers must receive ICE credentials to use TURN. Use restricted credentials with quotas and rotate them as the provider requires. Automatic issuance of short-lived TURN credentials is not implemented. See [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server).

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

Public REST endpoints use bounded in-memory token buckets with separate budgets for creation, joining, claiming samples, reads, and host actions. Excess traffic receives `429` with `Retry-After`. Health checks, CORS preflight, and participant leave requests remain available. Limits use the server-resolved client address; users behind a shared proxy can share a budget. Do not trust arbitrary forwarded headers to bypass this behavior.

Dependency check on October 9, 2026: `npm audit --omit=dev` reports zero vulnerabilities. The full audit reports five high-severity entries in the ESLint dependency chain, originating from [the braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No patched braces version is available. Keep lint inputs limited to the trusted repository and recheck for an upstream fix; a forced downgrade of Next.js tooling was not applied.
