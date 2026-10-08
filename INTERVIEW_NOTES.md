# Interview notes

## What I built

The four core features are a database-backed dashboard, instant meeting creation, joining by ID/link, and scheduling. Two-person WebRTC, host controls, screen sharing, and transient meeting chat are implemented on top of those workflows. The frontend is client-oriented even though it uses Next.js App Router.

## Why Next.js, FastAPI, and SQLite?

They are the assignment's required stack. Next.js gives organized routes, TypeScript support, and simple deployment. FastAPI validates requests through Pydantic, exposes Swagger, and supports both HTTP and WebSockets. SQLite keeps setup small and persists relational data in one file. SQLAlchemy keeps SQL and relationships readable.

SQLite is suitable for a small single-instance demo with short transactions. WAL mode allows readers alongside a writer, but SQLite still serializes writes. It is not a distributed database. The deployed file must live on a persistent volume.

## How do meeting IDs work?

`secrets.randbelow` creates a random 11-digit number. Randomness reduces collisions but does not guarantee uniqueness. A UNIQUE database constraint provides that guarantee. If insertion collides, the service rolls back and retries up to five times, then returns a clear error.

The internal database ID is separate from the public meeting code. Invitations contain only the public code.

## What happens when New Meeting is clicked?

The frontend sends a POST to FastAPI. The service selects the default organizer, creates the meeting, hashes a random host capability, and commits the record. The response includes the public meeting and the raw host capability once. The browser saves that capability and navigates to the prejoin screen.

The host capability is never included in the invitation. Someone opening a shared URL does not become host.

## How do users join?

The modal accepts an ID or an invitation from this application's origin. Direct invitation visits also work. Both routes load meeting details through the API and require a display name.

The join endpoint checks existence, meeting status, capacity, and any supplied host capability. It creates a participant row and returns a separate participant capability. The WebSocket authenticates with that capability in its first message. The client cannot choose its role or sender identity.

## How does scheduling work?

The browser combines local date/time, checks for invalid or nonexistent times, and converts the result to an ISO timestamp with UTC offset. It also sends its IANA timezone. Pydantic rejects naive timestamps, invalid zones, invalid duration, and missing fields. The service rejects past times, creates a code, and commits the schedule.

SQLite stores normalized UTC timestamps. API responses restore timezone awareness; UI formatting uses the viewer's local time. Upcoming and recent sections query stored status and timestamps. They do not use hardcoded frontend arrays.

Scheduled guests wait until the host starts. Unstarted schedules whose planned end has passed become missed. Active calls do not end merely because their planned duration elapsed.

## What does each table represent?

- User is the default organizer identity.
- Meeting belongs to one host and stores the schedule and lifecycle.
- MeetingParticipant records each admission, role, and join/leave/removal timestamps. Guests may have no User foreign key.

One user can host many meetings. One meeting can have many participant records, including historical sessions. Foreign keys are enabled explicitly because SQLite does not enforce them by default on every connection. Unique constraints protect codes, emails, session hashes, and seed keys.

## Why store token hashes?

Capabilities act like temporary passwords. A random 256-bit capability has enough entropy that SHA-256 is suitable for lookup/verification; it is not a human password needing a slow password hash. Hashes limit exposure if the database file is read. Raw host capabilities live only in the creating browser and the creation response.

This is intentionally simpler than accounts, but clearing localStorage loses ownership, and there is no recovery flow. A production product should use authenticated accounts and an explicit host delegation model.

## How do WebSocket signaling and WebRTC differ?

WebSockets carry small control messages: admission, roster events, offers, answers, ICE candidates, and host actions. They do not carry audio/video.

WebRTC establishes encrypted media transport between browsers. Each browser has a peer connection for the other participant. The lower participant ID creates the offer to avoid simultaneous offers. The answerer applies that offer and uses its transceivers before creating an answer. Candidates arriving before a remote description are queued.

STUN helps discover network addresses. TURN relays media when a direct connection is blocked. STUN alone cannot guarantee every network connection. This demo uses public STUN and accepts configured TURN servers.

## Why create audio/video transceivers even when devices are off?

The negotiated connection includes audio and video slots from the beginning. `replaceTrack` can fill those slots after a user enables devices. Device permission denial therefore does not prevent joining, and later enabling a device need not recreate the call.

## How are host controls enforced?

The WebSocket server loads the authenticated participant role from the database. Guest mute/remove requests are rejected. Remove updates the database, revokes the participant session, closes their socket, and notifies peers. Mute-all sends an instruction that the client handles by disabling its microphone tracks. It is not a media-server-level forced mute.

## How is concurrency handled?

Database sessions are short-lived. Admission uses `BEGIN IMMEDIATE` so two simultaneous joins cannot both pass a capacity check. Blocking database work called by async WebSocket handlers runs in a thread pool. Per-connection send locks keep outgoing events ordered.

The registry is in memory, so the backend runs one worker and one replica. Host disconnect has a small grace timer, but recovery is a fresh explicit join. A restart closes active calls and retains their history. Seamless recovery was deferred to protect the mandatory features.

## How is the code separated?

Routes translate HTTP input/output. Services own meeting rules and transactions. Models describe persistence; schemas describe validated API contracts. The room manager owns WebSocket membership and forwarding. Frontend API helpers centralize requests/errors, reusable dialogs own forms, and separate hooks handle devices and conference transport.

No generic repository framework or external media service was added; each layer has a concrete job.

## How did I verify it?

Backend tests use temporary SQLite files and exercise constraints, uniqueness retry, scheduling, ownership, capacity, signaling isolation, and cleanup. Browser tests use separate Chrome contexts and synthetic devices. They inspect actual inbound RTP packet counts in both directions, not merely the presence of video elements.

The browser suite also covers persistence after refresh, invalid joins, host-first waiting, device denial, removal, ending, and mobile layouts. Database survival across an actual backend restart is checked separately. Physical devices and cross-network media are reported separately from synthetic local verification.

## Why REST for meetings and WebSockets for a call?

Creating, scheduling, and retrieving meetings are independent request/response operations, so REST is easy to validate and test. A call needs the server to push roster changes, negotiation messages, chat, and host commands immediately. WebSockets keep one authenticated connection open for those events. The frontend reads an environment-configured HTTPS API origin and derives the corresponding WSS origin. CORS controls browser HTTP requests; a separate Origin check protects WebSocket entry.

## How do future samples stay available?

Real meetings always have a null seed key. Demo records have stable seed keys, so startup can recognize them without matching user titles. The service checks three demo slots for future unclaimed records. It inserts a replacement only when needed, using the slot and UTC date as a unique key. Existing records are never moved or deleted; expired schedules still become missed normally. A savepoint handles unique-key/code collisions without discarding another successful insert. Concurrent replenishment is regression-tested. The one-per-slot-per-day bound also prevents unlimited creation by visitors claiming demos repeatedly.

## What was wrong with negotiation, and how can I debug media?

Two asynchronous handlers could create simultaneous offers after duplicate join notifications. A per-peer offer guard and a serialized incoming-message queue remove that race. The answerer reuses the offer's transceivers instead of creating competing media slots. ICE candidates wait for a remote description with the matching ICE generation. Retry restarts ICE on the designated offerer while keeping the same participant session.

A roster alone proves signaling, not media. Inspect connection/ICE/signaling states, gathered and received candidate types, selected candidate-pair types, and inbound RTP counters. The copyable diagnostics exclude candidate addresses, SDP, tokens, and TURN credentials. The tests deliberately break candidate addresses, observe a real ICE failure, restore forwarding, and verify recovered audio/video. Without diagnostics from the original physical laptop call, I cannot prove that call had the same cause.

## How does screen sharing preserve the call?

The browser chooses a tab, window, or screen through `getDisplayMedia`, called from a user click. The hook keeps the camera stream, creates an outgoing stream with the microphone plus display video, and lets the conference hook replace the negotiated video track. Stopping or the browser's ended event stops capture and restores the camera's existing enabled/disabled state. Leaving, removal, and ending also stop capture. No second peer connection or new video m-line is needed. Shared system/tab audio is excluded to keep microphone behavior predictable. Synthetic canvas tests verify actual remote pixels, track restoration, and continuing audio; the native OS picker still needs manual checks.

## How does chat stay isolated and safe?

The authenticated room manager broadcasts chat only to sockets in that meeting. It derives the name and participant ID from admission, creates the message ID and UTC timestamp, trims text, rejects empty/oversized input, and limits a participant to two messages per second. React displays messages as text rather than injected HTML. Browsers retain only their latest 100 messages in memory; refresh and late arrivals do not get history. This avoids adding database tables for an optional assignment feature.

## What would change at Zoom scale?

Use accounts and audited authorization, PostgreSQL with migrations, shared signaling/presence, and an SFU instead of browser mesh. Add TURN capacity, short-lived credentials, rate limiting, observability, durable meeting events, backups, accessibility/browser testing, and regional deployment. Keep media transport separate from meeting management.

The next steps are stronger reliability, operational controls, and wider device/network testing.
