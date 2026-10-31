# Mobile shared browser session v1

Status: **DRAFT wire contract, implementation in progress; NOT deployed.** Branch: `codex/mobile-browser-v1`. Additive fields may follow; changes to the fields below will be called out explicitly. No public gateway support is claimed by this document.

## Client coordination addendum (31 October)

The following fields and request shapes are fixed for the v1 adapter. They remain **not deployed** until the capability is verified on the actual server.

- Confirmation acceptance: `POST /browser/sessions/{id}/commands` with `{"type":"confirm","observerId":"UUID","expectedRevision":17,"confirmationId":"UUID","decision":"accept"}` and `Idempotency-Key`. Refusal uses the identical shape with `"decision":"reject"`. Missing decision is invalid. Refusal invalidates that proposal and leaves the task `paused` on the same page, without submitting or automatically retrying the rejected action. `stop` instead terminates the whole task. Generic resume is not confirmation.
- Snapshots add nullable `assistanceRequest`: `{"requestId":"UUID","revision":17,"kind":"information","prompt":"For how many people?","responseActions":["answer","take_control","pause","stop"]}`. Kinds are `information`, `login`, `otp`, `captcha`, `clarification`, `blocked`. No password/OTP values appear. A spoken/typed answer uses `/utterances` with `{"observerId":"UUID","expectedRevision":17,"assistanceRequestId":"UUID","source":"voice","text":"Four people, please"}`. `source` is `voice` or `text` (default `text`); the transcript is forwarded unchanged. Only an actual answer to the current question may continue the original task after fresh observation. Corrections pause; commentary does not resume. Stale question IDs return 410 `browser_assistance_expired`. Login/OTP/CAPTCHA are completed by human input on the website, not supplied as model answers. Pause/stop remain available during assistance.
- `page.focus` and every `frame.focus` are `{"editable":true,"kind":"password"}`. Kinds are `none`, `text`, `password`, `otp`, `payment`; there are no current values or saved credentials. Metadata shares the frame/revision binding. Use secure input for password/OTP/payment; don't speak back, log or retain entered text. Masked password/OTP/payment fields are also masked in streamed screenshots where identifiable by native type/autocomplete. Unknown/custom fields remain website content; users must be able to choose secure entry themselves.
- Manual text input accepts optional `secure`: `{"type":"text","text":"...","secure":true}`. Carry the user's hidden/secure-entry choice in this field even when the website reports an ordinary text control. The server masks the marked field in preview and agent screenshots and redacts the entered secret from later textual agent observations. This does not promise that arbitrary website echoes can always be masked; returning to automation is refused while an entered secret is visibly echoed elsewhere in the page.
- Frame events additionally include a complete `session` snapshot, so page metadata, viewport, focus and revision remain synchronized with the pixels even if the first startup snapshot had no page. Render only a frame whose metadata matches that snapshot.
- Capability adds `"secureFocus":true,"accessibility":{"structuredPageControls":false}`. v1 supports accessible app controls and state/help announcements, but **does not expose a semantic webpage accessibility tree or named-control activation**. Do not imply VoiceOver access to the remote page itself.
- An observer sees the authoritative `user_control` state even when `control.observerId` is another device. In that case it is a viewer: input, resume, confirm and lease transfer are rejected. A direct owner Stop still works. Lease-bound commands include `leaseId` when control is held. Backgrounding a noncontrolling observer does not pause the other active controller. Closing/backgrounding the controller does pause, even if a second observer remains.
- Acknowledgements may contain a short `reply` for visible text and the app's existing speech output. The server decides its content; the phone does not run a browser decision model. Structured help remains visible until replaced/resolved; do not turn it into a second top-level conversation task.

## Reuse and scope

The existing `agents/browserAgent.ts` Playwright browser/context/page and model loop remain the executor. The phone displays real pixels from that page and sends input to it. It must not open a second WKWebView as the task surface. Existing tenant workers, account Bearer authentication, app model selection, browser network proxy and confirmation checks remain authoritative. Browser control routes bypass the ordinary conversation execution mutex, but do not bypass browser ownership or authorization.

Base path is the app's existing `/api/v1`; use the same origin and account `Authorization: Bearer …`. Never put authorization, cookies, typed content or credentials in a URL. A missing `browserSession` capability means this feature is unavailable; retain the old chat UI. Do not infer support from the server version or a successful ordinary message.

## Negotiation and starting a task

`GET /capabilities` adds:

```json
{"browserSession":{"version":1,"available":true,"transport":"sse-jpeg","activePath":"/api/v1/browser/sessions/active","maxObservers":2,"maxFrameRate":1,"inputs":["tap","scroll","text","key","back","reload"],"backgroundPolicy":"pause","observerTimeoutMs":15000}}
```

Send a natural-language task through the existing `POST /messages`, with its existing `Idempotency-Key`. Opt in with `X-Kira-Browser-Session: v1`. The server classifies it normally; this header never forces browser routing. `operationId` in the browser contract is that message's exact `Idempotency-Key` (an opaque operation identifier, not a credential). The original message may still be running; do not wait for its response before discovering a browser session. Poll active discovery at most once per second while that operation is pending. Typed/voice corrections use the dedicated utterance route below, not the held ordinary-message lane.

`GET /browser/sessions/active?operationId=<operationId>` returns `{"session":null}` until the existing agent creates a shared session, or `{"session":<snapshot>}`. Omit `operationId` to recover this account's latest active shared session after app restart. Only this account's API conversation is exposed. IDs from another account return 404. One live task per account/conversation; starting another task never silently replaces it.

## Snapshot and observer lifecycle

`GET /browser/sessions/{sessionId}` returns `{"session":<snapshot>}`. Fields:

```json
{"version":1,"sessionId":"UUID","operationId":"client-operation-key","revision":7,"eventSeq":25,"state":"user_control","control":{"owner":"user","observerId":"UUID","leaseId":"UUID"},"page":{"pageId":"UUID","navigationEpoch":3,"viewportRevision":1,"url":"https://restaurant.example/","origin":"https://restaurant.example","title":"Synthetic restaurant","viewport":{"width":1280,"height":720,"deviceScaleFactor":1}},"frame":{"frameSeq":12,"eventSeq":25,"pageId":"UUID","navigationEpoch":3,"viewportRevision":1,"revision":7,"imageWidth":1280,"imageHeight":720,"capturedAt":"2026-10-31T12:00:00.000Z","mime":"image/jpeg"},"pendingConfirmation":null,"inFlight":false,"externalEffect":"none","expiresAt":"2026-10-31T12:15:00.000Z","lastCommand":null,"reason":null}
```

`page`/`frame` may be null during startup. URL metadata exposes only the origin plus `/` in v1, deliberately omitting path, query, fragment and userinfo (tokens can occur in paths). Title is bounded and redacted; pixels can still contain private website content. `revision` changes on state/control/page changes or accepted input; it does not change merely because a new screenshot is captured. `eventSeq` and `frameSeq` increase for the lifetime of a session. `pageId` changes when the canonical tab changes; `navigationEpoch` changes on navigation, including same-document navigation. `viewportRevision` changes on resize. Device rotation scales the existing remote viewport; v1 does not expose arbitrary remote viewport resizing.

States: `starting`, `running`, `pausing`, `paused`, `user_control`, `needs_user`, `awaiting_confirmation`, `completed`, `cancelled`, `failed`, `disconnected`. The server is authoritative. `pausing` does not grant user input. `disconnected` is a safely suspended session, not permission to resume. Terminal states never resume. `externalEffect` is `none`, `possible`, `confirmed` or `unknown`; stopping does not claim an already submitted external action was undone.

Create an observer with `POST /browser/sessions/{id}/observers`, body `{"observerId":"client-generated-UUID"}`, and an `Idempotency-Key`. A repeated registration for the same observer is safe. At most two observers may be connected. Replacing a connection for the same observer invalidates the old connection. `control.leaseId` is a coordination nonce, not authentication; Bearer and observer ownership are still checked. Only one observer can hold the input lease.

## Live events, frames and reconnect

`GET /browser/sessions/{id}/events?observerId=<UUID>&after=<lastEventSeq>` is an authenticated SSE response. Native URLSession must attach Bearer, read incrementally and cancel the connection on background. No token-bearing EventSource URL, VNC, CDP or debug port is exposed. Every connection begins with an authoritative `snapshot`; replace local state and discard older buffered events. Then apply only increasing sequence numbers. `after` detects a missed interval, not permission to replay commands. Reconnect always receives current state; actions never replay. Metadata retention is bounded; clients must handle snapshot resynchronization rather than demand an unbounded event history.

```text
id: 25
event: snapshot
data: {"seq":25,"session":{...},"resync":true}

id: 26
event: frame
data: {"seq":26,"sessionId":"UUID","frame":{"frameSeq":13,"eventSeq":26,"pageId":"UUID","navigationEpoch":3,"viewportRevision":1,"revision":7,"imageWidth":1280,"imageHeight":720,"capturedAt":"...","mime":"image/jpeg"},"jpegBase64":"..."}

id: 27
event: state
data: {"seq":27,"session":{...}}
```

State events also carry `lastCommand` when a command is acknowledged. Frames are real screenshots, at most 1 fps, viewport-only, with no frame history on disk. Slow observers are disconnected instead of accumulating image queues; reconnect obtains a fresh snapshot/frame. Frame size is bounded. SSE keepalive comments are sent while idle. A client must send `POST /browser/sessions/{id}/heartbeat` with `{"observerId":"UUID"}` every 5 seconds while foreground; incoming frames alone do not prove the app is still active. Heartbeats are idempotent and do not need an Idempotency-Key.

If the controlling observer backgrounds/disconnects/expires, the server immediately revokes future automation/input and drains any in-flight browser action before `disconnected`. With no controller, losing the last observer has the same effect. Initial attachment has a 15-second grace period. Reconnect never resumes automation. A remaining observer may explicitly take control/resume after suspension. Paused/disconnected sessions expire after 15 minutes; terminal snapshots are retained briefly in memory. Worker restart loses live sessions; 404 `browser_session_gone` requires a new user request, never automatic resubmission of a booking.

## Explicit commands and acknowledgements

`POST /browser/sessions/{id}/commands`, with `Idempotency-Key`:

```json
{"type":"take_control","observerId":"UUID","expectedRevision":7}
```

Types: `pause`, `take_control`, `resume`, `stop`, `background`, `confirm`. Every command except `stop` requires the last snapshot's `expectedRevision`; stale commands fail with 409 `browser_revision_conflict` and the client refreshes. `stop` intentionally ignores stale revision, is idempotent, immediately invalidates future actions, and may report an uncertain in-flight external effect. `background` is sent best-effort before closing the stream. `confirm` additionally carries the current `confirmationId`; a generic resume never grants consent. The current controller's `leaseId` is required for resume/confirm when user control is held. A second observer cannot steal a live control lease.

```json
{"commandId":"same-idempotency-key","accepted":true,"session":{...}}
```

Pause/takeover acknowledgements wait for the current browser action to drain before granting input. The `pausing` state is emitted immediately. Resume invalidates the old plan and starts a fresh observation/model step from the same page. Stale tool/model results cannot act after takeover or stop. Identical command keys return the same receipt; a changed body with that key returns `idempotency_conflict`. HTTP timeout is not permission to retry with a new key. The client renders the returned server state rather than optimistically claiming success.

## Human input and coordinate mapping

`POST /browser/sessions/{id}/input`, with `Idempotency-Key`:

```json
{"observerId":"UUID","leaseId":"UUID","expectedRevision":7,"frameSeq":13,"pageId":"UUID","navigationEpoch":3,"viewportRevision":1,"input":{"type":"tap","x":620,"y":410}}
```

Input is accepted only in `user_control` with the current lease, revision, live page/viewport and a displayed frame no older than two seconds. Rejected input is never queued for later. Each successful input invalidates earlier frame/revision references; await a new frame before the next gesture. Server returns the same acknowledgement envelope as commands. Duplicates never click or submit twice.

Coordinates are **CSS viewport pixels**, not iPhone points or JPEG pixels. For an aspect-fit preview, subtract letterbox offsets, then `x = localImageX / displayedImageWidth * viewport.width` and similarly for `y`. Reject taps in letterboxing. `imageWidth / viewport.width` is the horizontal JPEG-to-CSS scale; use the metadata, not an assumed Retina factor. Screenshot scrolling is viewport-relative.

Other `input` forms:

```json
{"type":"scroll","deltaX":0,"deltaY":400}
{"type":"text","text":"text for the currently focused field"}
{"type":"key","key":"Enter"}
{"type":"back"}
{"type":"reload"}
```

Text inserts into the currently focused editable control; no arbitrary JavaScript/selectors/URLs are accepted. Keys are an allowlist (`Enter`, `Tab`, `Backspace`, `Delete`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`). Back/reload remain subject to the existing network boundaries. Text/keys that submit can have an external effect. A deliberate authenticated human action is the user's action; automation cannot use that action as blanket permission for later commitments.

## Typed and voice corrections

`POST /browser/sessions/{id}/utterances`, with `Idempotency-Key`:

```json
{"observerId":"UUID","expectedRevision":7,"text":"Wait, let me log in; then change the booking to four people."}
```

Voice is transcribed by the existing app voice path; send the transcript here. The server uses its configured semantic model to interpret `pause`, `stop`, `take_control`, `resume`, a correction, or ordinary commentary in the active task context. No phrase-template router. A correction suspends and invalidates the plan, records the revised task requirement in memory for this run, and requires explicit resume. Commentary never implicitly resumes. Response adds `interpretation` and a short `reply` to the command acknowledgement. Model uncertainty returns a clarification, with no browser action. Fast UI stop remains independent of model availability. The implementation must share this handler with normal conversational browser controls where that conversation is not mutex-blocked.

## Consent, privacy and errors

Login, OTP and CAPTCHA require user control; Kira does not solve CAPTCHA. Final booking/order/payment/other external commitment requires a current action-specific `pendingConfirmation` (`confirmationId`, bounded `summary`, current `revision`) or the user's direct input. Confirmation expires on navigation, changed requirements, takeover and changed action. Stop during submission reports uncertainty, never retries it automatically. Website text cannot become control commands or grant consent.

Frames are delivered only to authenticated observers on the account and may contain private page content. Do not persist them in app history, analytics or caches by default. Server retains only the latest short-lived frame, bounded metadata/receipts and the live browser task; raw typed input is never logged, sent to the model, or persisted. Existing server-side browser cookies/credential storage retains its existing lifecycle, separate from frame retention. Credentials entered in a form are sent to that website as requested by the user. Do not send the phone's pixels to a second model/provider for this feature.

Errors use existing `{"error":{"code":"...","message":"..."},"requestId":"..."}` envelopes: 401 unauthorized; 404 session gone/wrong account; 409 revision conflict, control busy, stale frame or idempotency conflict; 410 expired confirmation; 422 invalid input; 429 bounded rate/observer limit. Resynchronize on stale/conflict; never blindly replay input. No action endpoint redirects to an arbitrary origin.

## Gateway and rollout

Required public additions are only the authenticated `/api/v1/browser/sessions/...` paths above. The platform gateway must forward `X-Kira-Browser-Session` on `/messages`, stream SSE without buffering, preserve content type/no-store, close upstream when the client disconnects, and allow sufficiently long read timeouts. Browser frames/heartbeats need a separate bounded authenticated rate budget so they do not exhaust the ordinary chat 120/minute budget. No unauthenticated routes or extra exposed ports. Exact Nginx allowlist/config patch and backend validation evidence will be appended after implementation. Only the MacBook operator changes the external proxy; this branch does not claim those changes have happened.

Acceptance still required: real existing-agent automation → same-page human click → explicit fresh-plan resume → stop; account isolation; stale frame/navigation/resize; in-flight races; duplicate submission/consent; reconnect/background; full server suite. iPhone rendering, voice UX and external network streaming require device-side validation.
