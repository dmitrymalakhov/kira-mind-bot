# Public accounts — canonical contract v1

Contract ID: `kira.public-accounts.v1`, schema `version: 1`. Canonical TypeScript shapes: `platform/publicAccounts/contracts.ts`. This document specifies the complete first-release target. It does **not** claim unimplemented routes or configured providers are available: `GET /api/v1/auth/config` advertises actual readiness. Base: `d67b62687c4435ffab0410af0c2067a86b269028` (2026-11-03).

## Invariants and compatibility

Account ID is a server-issued UUID. Unique identity key is `(provider, verified subject)`; email/name/Telegram profile ID never merges accounts. Existing imported UUID, positive Telegram owner ID, database, memory namespace, bot profile, API key and runtime directory remain unchanged. New API-only accounts use a separate internal numeric runtime principal, outside the positive Telegram identity domain; it is never a Telegram identity or an HTTP parameter.

The native client uses `account.accountState`, `runtimeState`, `isReady` and capabilities. It must remove the old `account.bot != null && bot.connected` readiness gate. `registered` accounts may manage settings/identities/sessions/consent/delete without runtime resources. `POST /account/activate` queues provisioning after abuse checks; AI consent is not a prerequisite for non-AI runtime features. `isReady` means `accountState == active && runtimeState == ready`, independent of AI consent. `api_only` requires neither Telegram nor personal bot credentials. No permission prompts or purchases are registration gates.

Existing password credentials and issued bearer endpoints remain supported. Legacy `POST /accounts/login` retains its existing username/password request and 30-day static session for **already existing password accounts only**, protected by durable IP and failed-password limits; it never creates an account. New native clients use challenge/proof-protected `/auth/password` and receive a rotating pair. Native provider/password proof requirements are unchanged. Legacy static sessions/API keys remain valid until their existing expiry/revocation, with the same outbound restriction/consent/quota gates as native sessions. Static Bearer can GET the actual `/account/consents` catalog and explicitly PUT its version/recipient IDs, so the owner can complete migration without being locked out of account management. No AI consent is inferred from old login or past activity. Public `POST /accounts/register` is always `410 registration_closed`, including when new providers are disabled. Trusted local import remains separate. New autonomous AI starts disabled.

## Transport, receipts and errors

All paths below start `/api/v1`. HTTPS only outside loopback. JSON mutation bodies carry `version:1`; unknown identity/account/chat/user fields are rejected. Account is derived from the server session. Dates are UTC RFC3339; IDs are UUID unless stated; token secrets travel only in JSON bodies/Authorization headers, never query parameters or logs. Responses have `Cache-Control:no-store`. Bodies are bounded to 64 KiB except existing photo/scene/workout limits.

Every native mutation except initial challenge needs `Idempotency-Key` (8–128 `[A-Za-z0-9_-]` characters). Receipt is account/session/challenge-scoped, fingerprint includes method/path/body. An authorized same-key/body retry replays the original outcome; changed request is `409 idempotency_conflict`. Persist intent before effects; interrupted unknown external outcome is `409 operation_uncertain`, not automatic re-execution. Auth token results may be held account-bound AES-GCM encrypted for 120 seconds; refresh hashes remain the primary credential store. A maintenance pass every 60 seconds clears expired encrypted replay bodies and expired proof/rate windows; their authorization deadline remains 120 seconds even between cleanup passes.

Two terminal exceptions take precedence over generic receipts. Successful logout revokes the bearer, so retrying logout with it returns `401`; the client clears its local session. Accepted account deletion revokes all bearers, so a lost DELETE response followed by `401` is an **unconfirmed deletion outcome**, never proof that all stores were erased. Retain only nonsecret request key/account UUID/server identity for reconciliation, do not repeat with a new key, do not automatically sign in and accidentally create a replacement account. Refresh reuse is a separate security protocol: changed device with the same old token/key is `401 refresh_invalid` and revokes that family, rather than a generic receipt conflict.

Common error shape: `{ "error": { "code":"consent_required", "message":"…", "requiredConsentVersion":"catalog-sha256" }, "requestId":"uuid" }`. Auth failures never reveal whether an account/identity exists. Errors: 400 `invalid_body`, 401 `unauthorized`/`invalid_credentials`/`invalid_provider_proof`/`challenge_invalid`/`refresh_invalid`, 403 `app_proof_invalid`/`app_attest_key_unknown`/`captcha_required`/`consent_required`/`account_restricted`/`account_deleting`, 409 `pkce_reused`/`identity_conflict`/`last_identity`/`reauthentication_required`/`idempotency_conflict`/`operation_uncertain`, 410 `registration_closed`, 429 `rate_limited`/`quota_exhausted`, 503 `provider_unavailable`/`proof_unavailable`/`runtime_unavailable`/`feature_unavailable`. `Retry-After` accompanies 429 and retryable 503.

## Endpoints and authorization

| Method/path | Access and body | Response |
| --- | --- | --- |
| GET `/auth/config` | Public | `AuthConfig`: all three provider availability entries, public client IDs, exact configured redirects, consent catalog, links, implemented capabilities; never secrets |
| POST `/auth/challenges` | Public login; Bearer for reauthenticate/link. `ChallengeInput` | `AuthChallenge`, five-minute, provider/device/purpose/session-bound, one use |
| POST `/auth/apple`, `/auth/google`, `/auth/telegram` | `ProviderLoginInput`; Bearer for authenticated challenge | `LoginReply`, or `ReauthenticationReply`, or linked `IdentityView` |
| POST `/auth/password` | `PasswordLoginInput` for existing users | Same native session; never creates password account |
| POST `/auth/refresh` | Public `RefreshInput`, idempotency required | `TokenPair` |
| POST `/auth/logout` | Bearer, `{version:1}` | `{version:1,ok:true}`; revoke current family and its push binding |
| GET `/account` | Bearer (legacy compatible) | `{account:AccountView}`; extra fields extend existing account/bot shape |
| GET `/account/identities` | Bearer | `{version:1,identities:IdentityView[]}`; no raw subject/email |
| DELETE `/account/identities/{identityId}` | Bearer, `{version:1,reauthenticationToken}` | `{version:1,ok:true}`; cannot unlink last method; invalidate affected sessions |
| GET `/account/sessions` | Bearer | `{version:1,sessions:SessionView[]}` |
| DELETE `/account/sessions/{sessionId}` | Bearer, `{version:1}` | `{version:1,ok:true}`; owner-only; current logout supported |
| GET `/account/consents` | Bearer | `{version:1,catalog:ConsentCatalog,acceptedVersion:string|null,aiAllowed:boolean}` |
| PUT `/account/consents` | Bearer, `ConsentInput` with exact catalog and recipient list | Same view; decline/revoke keeps account management available |
| POST `/account/activate` | Bearer, `ActivationInput` | 202 `{version:1,account:AccountView}`; durable state, idempotent, max ten checks/15 min |
| GET `/account/quota` | Bearer | `{version:1,quota:QuotaView}` |
| DELETE `/account` | Bearer, `DeleteAccountInput`, explicit fresh confirmation | 202 `DeletionReply`; immediately revoke admission/sessions/jobs |
| PUT `/account/push-devices` | Bearer, `PushDeviceInput`; device must match current session | `{version:1,registered:true}` |
| DELETE `/account/push-devices/{deviceId}` | Bearer, `{version:1}` | `{version:1,ok:true}` |
| GET `/notifications?limit=20&cursor=opaque` | Bearer, limit 1–100, stable cursor | `NotificationPage` |
| POST `/notifications/{id}/read` | Bearer, `{version:1}` | `{version:1,ok:true}` |
| POST `/account/complaints` | Bearer, `ComplaintInput` for owned reply only | 202 `{version:1,complaintId:"uuid",status:"received"}` |

Provider revocation notifications are a separate strictly verified provider-to-server route, never a client assertion that an identity was revoked. Until deployed callbacks/revalidation exist, provider availability must not claim a completed release gate.

## Three sign-in flows and proof binding

Selected providers appear on one screen; an explicitly disabled provider is hidden. `KIRA_PUBLIC_IDENTITY_PROVIDERS=google,telegram` selects the current Personal Team test release; its default is `apple,google,telegram` for compatibility. A selected provider is available only when its own configuration and the common proof/consent/deletion/release gates are ready. Missing Apple credentials never disable a configured Google or Telegram provider. Push is optional and honestly advertised false without APNs; the durable inbox still works. `RELEASE_READY=true` is an operator acceptance gate, not an automatic conclusion from key presence.

Native Apple uses AuthenticationServices; Google uses the official iOS SDK **with the nonce overload** (pin a published SDK exposing it); Telegram uses `ASWebAuthenticationSession` with official OIDC code flow and S256 PKCE. No iframe, password bot or custom Telegram signature substitute. Personal Team cannot assume App Attest or APNs entitlements: inspect the signed app's actual capability and `DCAppAttestService.isSupported`, and use configured hCaptcha for unsupported devices. Never advertise an unverified physical-device flow as accepted.

1. Generate device UUID locally and retain in Keychain. Telegram generates a 43–128-character PKCE verifier locally; send only S256 challenge to `/auth/challenges`.
2. Each new Telegram challenge requires a freshly generated PKCE verifier. Reuse of its S256 value, across devices/purposes or after a lost/failed/expired/removed challenge, returns `409 pkce_reused`. A durable binding retains only the S256 hash and original opaque challenge UUID, with no account/device/provider PII; deleting the challenge never frees that grant for another flow. Authentication rechecks this original binding. Same-flow completed retries keep their original challenge and key.

   Server creates random challenge/state/nonce, stores expiration/provider/device/purpose and optional current session + reauthentication grant. Response includes public challenge material and, for Telegram, a fixed-origin authorization URL. Client cannot choose issuer/JWKS/redirect/client ID.
3. Apple request receives `nonce` and `state` from challenge unchanged. Submit identity token **and** authorization code. Google request uses nonce overload, web-server client ID audience, submits ID token. Telegram system return must have exact registered callback, matching state and code; client posts code + verifier + state to backend, never token in return URL.
4. Server verifies trusted signature, algorithm, issuer, configured audience, expiration and issuance time. Apple/Google nonce is required; Telegram nonce is checked when present (its discovery does not advertise a nonce claim), with code/state/PKCE/device proof mandatory regardless. Apple code is exchanged server-side, returned identity checked against the original, refresh/revocation credential encrypted account-bound. Telegram exchanges code with server-only secret + fixed redirect and PKCE; identity comes from verified ID token (there is no assumed userinfo endpoint).
5. Before completing login, verify real app proof over the exact `proofPayload` below; one-use challenge consumption and account/identity/session creation are transactional. Concurrent signup for one identity produces one UUID; retry has receipt semantics. No name/email/phone prompt.

`proofPayload` is UTF-8, exactly these lines (LF, no final LF):

```text
kira.public-accounts.v1
POST
/api/v1/auth/{provider}
{challengeId}
{challenge}
{deviceId}
{state}
{sha256-hex(identityToken-or-empty)}
{sha256-hex(authorizationCode-or-empty)}
{sha256-hex(codeVerifier-or-empty)}
```

For `/auth/password`, replace the last three lines with SHA256(username lowercase), SHA256(password), SHA256(empty), respectively; never log a real payload. App Attest first registration supplies `attestation` with clientDataHash = **SHA256(UTF8(challenge string exactly as received))**, not decoded base64 bytes, and `assertion` with clientDataHash = **SHA256(UTF8(proofPayload))**. `keyId`, `attestation`, `assertion` use canonical standard base64 including padding; no base64url or omitted padding. Subsequent requests supply key ID + assertion. Server checks Apple certificate chain/root/nonce, app/team/environment/key hash, assertion signature/app hash and strictly increasing sign count with transactional CAS. A cryptographically invalid supplied object is terminal `app_proof_invalid`, never a captcha downgrade. No boolean client attestation flag. Deterministic synthetic bytes/digests are in `public-accounts-v1.examples.json`.

Namespace client Keychain key references by **server identity + `proof.appAttestAppId` (team.bundle) + `proof.environment`**; the environment comes from the signed build and must equal server configuration. Reinstall, key loss or a registry reset can yield `403 app_attest_key_unknown` only for a missing server key and an assertion-only submission. The old challenge is consumed. Recover with a new challenge, a freshly generated Apple key and a new attestation plus assertion; restart provider authorization as needed. Never re-attest an already attested key, overwrite an existing key/counter, replace proof on the consumed challenge, or convert this error to a captcha retry. Known-key signature/counter/device/environment mismatch remains `app_proof_invalid` and never resets a key. An explicit genuinely new unsupported-device flow may use hCaptcha, subject to the same limits.

Challenge `proofRequirement` has exactly two valid combinations: `{mode:"app_attest_or_hcaptcha",reason:null}` and `{mode:"hcaptcha",reason:"risk"}`. `hcaptcha/null` is never emitted. In normal mode an unsupported device submits hCaptcha reason `unsupported`, a temporary platform failure uses `temporarily_unavailable`; risk mode uses `risk`. UI loads the exact public `hcaptchaBaseUrl` and verifies `hcaptchaHostname`, never infers these from the API URL. Sitekey/secret/verified hostname must be configured before release.

If risk rises after challenge issuance, a valid App Attest submission returns `403 captcha_required` with `error.proofRequirement={type:"hcaptcha",reason:"risk",challengeId,siteKey,baseUrl,hostname}` before provider code exchange. Replace only the proof with hCaptcha for the same unconsumed challenge and Idempotency-Key; a malformed or unknown App Attest key is terminal instead. Server POSTs to official siteverify with configured secret, expected sitekey and trusted IP, success-only, bounded timeout and durable token-hash anti-replay. Captcha never bypasses auth/activation/identity limits. Network failure fails closed `proof_unavailable`.

`reauthenticate` challenge proves an identity already linked to current account (or existing password), then returns a one-use five-minute opaque grant bound to session/account and purpose. Linking challenge additionally consumes this fresh grant and proves new provider identity; conflict leaves original ownership unchanged. Unlink/delete consume a fresh grant transactionally. Tokens alone, client timestamps or Apple credential state booleans are not fresh proof.

Password reauthentication uses the current native Bearer for both POST `/auth/challenges` (`provider:"password",purpose:"reauthenticate",deviceId`) and POST `/auth/password` (password input + proof + Idempotency-Key). Its response is the bare `{version:1,reauthenticationToken,expiresAt}`, without access/refresh tokens. Link-purpose `/auth/{provider}` returns a bare `IdentityView`, without an `identity` wrapper. A static legacy bearer first needs native password sign-in to obtain a native session.

Provider PII: Google/Telegram email/name/picture claims may arrive transiently inside verified JWTs, but are neither logged, copied to account profile, persisted, nor used for account linking. Only `(provider,sub)` crosses the verifier boundary. There is no provider userinfo/profile download. Auth fingerprints store a digest, never the raw JWT; temporary encrypted auth replay contains server session/account results rather than provider claims. The client-supplied device name is persisted separately. This is transient processing, so privacy declarations must not claim these claims never reach the server. Apple revocation tokens are the documented encrypted exception.

## Refresh concurrency and session lifecycle

Access: opaque random 256-bit bearer, 900 seconds. Refresh: independent random 256-bit secret, 30-day absolute family lifetime; server stores hashes. Native serializes refresh per session in one actor and persists the **request Idempotency-Key before sending**. The compatibility exception is the existing legacy password endpoint/static bearer; it cannot create accounts or grant AI consent. New native sessions always rotate.

Rotation transaction locks old refresh row/family. First valid use revokes old access, replaces refresh and returns new pair. **Exact same old token + device + idempotency key/body** may replay the encrypted pair for 120 seconds; no extra rotation. Same old token with another key/device, or outside retry window, is reuse: revoke whole family, access and associated push binding; return `401 refresh_invalid`. A retry of an older rotation never returns tokens after a newer rotation/revocation. Concurrent callers must share the original key; losing an outcome past 120 seconds requires sign-in. No static-token fallback. Mobile uses `/auth/password` for existing password credentials.

Session/device list contains no bearer/provider subjects. Logout/revocation takes effect at next authorized operation. Provider revocation revokes that identity's families. Revoke other sessions cannot target another account. Push binding belongs to active session/device; logout, account swap, refresh reuse and APNs unregistered response remove binding.

Complaint `replyId` is **`String(ApiReply.messages[i].id)`**, preserving a possible minus sign; it is a decimal string, not a UUID or text. The server resolves it only against that account's completed reply receipts.

## AI consent, quota and moderation

Catalog version is a deterministic digest of actual recipient/data/purpose descriptors, including gateway recipients and fallback routes, text/images/audio/search/embeddings and any other external AI. Every recipient must have a reviewed descriptor; unknown/unlisted recipients are blocked. UI displays catalog before acceptance. Accept exact current version+recipient IDs, decline or revoke via the same endpoint. Revocation/new recipients block at **actual outbound execution**, including queued/background/fallback calls, not only HTTP admission. No user data or metadata is sent to an external moderation service before matching consent. Local commands/account/workout recording spend nothing.

Default UTC budgets: AI operations 20/day, generated images 1/day, server configurable. Reserve once per server account + logical user operation + UTC admission day. The durable unique operation key spans retries, channels/legacy credentials, model fallback and tool steps. An image operation reserves AI + image atomically, or neither. Each distinct image generation has a separate server-private effect ID and its own UTC admission day; two images in one AI turn spend two image units. Retries of that same image effect reuse its unit, while the AI turn is charged once. Unused reservations expire after five minutes, release their counters, and fence late workers; committed/uncertain sends never expire into a refund. Text transport cleanup cannot release another concurrent image effect. Commit each relevant budget immediately before its first authorized outbound send; internal retries reuse committed units. Release reservation only if no corresponding outbound attempt happened. Ambiguous crash after commit keeps unit spent; never refunds an uncertain external request. Failed preflight/local-only commands release unused reservation. Midnight changes new operations, never re-bills an existing operation. Counters/receipts persist across processes/restarts; UTC reset is next day 00:00Z. Return used/reserved/remaining/resetAt; unavailable policy storage denies outbound.

New autonomous AI OFF is a persistent account setting, checked before jobs start and again at outbound execution. Explicit foreground consent does not silently enable paid autonomous behavior. Existing channels inherit account restriction/consent/quota gates through the same execution policy. Prohibited-content checks must execute at actual request/output boundaries; client warning text alone is not moderation. Complaints reference owned server reply IDs, persist for review; restriction blocks AI admission while preserving settings/delete.

## Durable inbox, APNs and deletion

Persist inbox event first and APNs outbox in the **same database transaction**. Push has generic text plus event UUID only (`aps.alert.body = "Новое уведомление Kira"`, `eventId`); no reminder/chat/health/body content. Fetch content after bearer authorization. Denial/outage never removes inbox; retry APNs with bounded backoff, separate sandbox/prod endpoints and configured bundle topic. Do not count APNs accepted as delivery confirmation. Closed-app/device/account-swap acceptance is a physical-device release check.

Delete transaction tombstones account, blocks admission/sessions/push/background immediately and creates durable per-store task. A leased retry worker stops runtime, revokes Apple refresh token at official endpoint, removes owned registry/tenant database/profile/Qdrant namespace/files/notification/device/credential data, recording each completed step. Shared infrastructure/product assets never deleted. Imported data uses explicitly recorded ownership bindings, not guessed path/name. Failed revocation/cleanup stays pending and resumes after restart. Account settings/deletion status remains auditable without retaining personal payloads in telemetry. Tombstone/restore ledger is outside account-deleted data and applied before restored runtime serves requests. Provider identity re-signup cannot race deletion or revive old namespace.

Operational target is <=24h; backup retention target 30 days. **Neither is a user-facing promise until actual backup inventory, retention configuration, deletion scheduling/alerts and restore drill are verified.** Contract/config exposes unverified infrastructure as a release blocker. No real owner deletion/provider revocation during automated acceptance.

## Redirects, credentials and public gateway prerequisites

No domains, app IDs, support contacts or policy URLs are invented here. Configure actual published assets. Missing privacy/support links block readiness; null links describe disabled configuration. Operator-hosted local LMStudio and LMRouter transport are disclosed as operator-kira, with a real operator privacy URL, rather than attributing local prompts to the LMStudio vendor.

| Server-only / public configuration | Requirement |
| --- | --- |
| `KIRA_PUBLIC_ACCOUNTS_ENABLED` | Default false until all release gates pass; `/auth/config` still returns disabled config |
| `KIRA_PUBLIC_RELEASE_READY`, `KIRA_PUBLIC_IDENTITY_PROVIDERS` | Explicit operator acceptance; comma-separated selected providers, default all three, current test target `google,telegram`. Disabled entry reason is `disabled`; missing selected provider does not disable another configured provider |
| `KIRA_PUBLIC_APPLE_CLIENT_ID`, `KIRA_PUBLIC_APPLE_TEAM_ID`, `KIRA_PUBLIC_APPLE_KEY_ID`, `KIRA_PUBLIC_APPLE_PRIVATE_KEY_FILE` | Native bundle audience, Sign in with Apple capability/key; ES256 client-secret signing, code exchange, encrypted revocation token; key file readable only by server |
| `KIRA_PUBLIC_GOOGLE_CLIENT_ID`, `KIRA_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Web client ID is backend audience; iOS client bound to exact bundle. Configure SDK reversed iOS-client-ID URL scheme; use published SDK with nonce overload |
| `KIRA_PUBLIC_TELEGRAM_CLIENT_ID`, `KIRA_PUBLIC_TELEGRAM_CLIENT_SECRET`, `KIRA_PUBLIC_TELEGRAM_REDIRECT_URI` | BotFather official Login configuration. Redirect is one exact configured app-return URI, registered verbatim; native system callback scheme/associated domain must match it; server never accepts body redirect |
| `KIRA_PUBLIC_APP_BUNDLE_ID`, `KIRA_PUBLIC_APP_TEAM_ID`, `KIRA_PUBLIC_APP_ATTEST_ENVIRONMENT` | Exact Apple app ID hash; production for TestFlight/App Store, explicit development only for development deployment |
| `KIRA_PUBLIC_HCAPTCHA_SITEKEY`, `KIRA_PUBLIC_HCAPTCHA_SECRET`, `KIRA_PUBLIC_HCAPTCHA_HOSTNAME`, `KIRA_PUBLIC_HCAPTCHA_BASE_URL` | Expected sitekey/hostname and real keys; exact HTTPS UI origin must match hostname; default base URL is `https://{configured hostname}`, never a caller header |
| `KIRA_PUBLIC_PRIVACY_URL`, `KIRA_PUBLIC_SUPPORT_URL` | HTTPS accepted public assets, no placeholder policy/SLA |
| `KIRA_PUBLIC_AI_CATALOG_FILE` | Reviewed actual external recipient/data/purpose catalog; deterministic consent hash, no inferred consent |
| `KIRA_PUBLIC_AI_DAILY_LIMIT=20`, `KIRA_PUBLIC_IMAGE_DAILY_LIMIT=1` | Integer server limits; never request-selected |
| `KIRA_PUBLIC_GATEWAY_PEERS`, `KIRA_PUBLIC_GATEWAY_SECRET` | Exact trusted immediate proxy IPs and authenticated overwritten real-IP header; never trust arbitrary X-Forwarded-For |
| `KIRA_PUBLIC_APNS_TEAM_ID`, `KIRA_PUBLIC_APNS_KEY_ID`, `KIRA_PUBLIC_APNS_PRIVATE_KEY_FILE`, `KIRA_PUBLIC_APNS_TOPIC` | APNs signing key/topic; device binding selects sandbox/production, keys server-only |
| deletion/backup config | Verified owned-storage inventory, worker lease/alerts, retention30d, restore ledger barrier; no blanket volume prune |

Public routes: GET `/auth/config`, POST `/auth/challenges`, `/auth/apple`, `/auth/google`, `/auth/telegram`, `/auth/password`, `/auth/refresh`, legacy `/accounts/login`. All account/inbox/logout routes require bearer; root gateway adds exact methods/paths, forwards Idempotency-Key, strips client internal policy/real-IP headers, overwrites authenticated gateway IP. Public `/accounts/register` is explicitly closed. Durable per-public-IP 30 auth requests/min; known-account failed login 5/15min with same public failure shape for unknown users; activation10/15min. Hash IP keys with operator secret and retain only necessary windows. Direct loopback worker API is not public and must enforce account policy too. VPS allowlist changes are review artifacts only; only root can deploy them.

For the current app-specific test callback, intended configuration is `kiramindauth://tglogin`, registered verbatim in BotFather and in the app's URL schemes. This is a fixed operator configuration, never a caller-supplied URL; actual Telegram acceptance remains unverified until registration/device testing. Telegram's official iOS documentation permits a custom-scheme fallback when Universal Links cannot be supported. Code+PKCE and server-only secret exchange remain unchanged.

## Incremental implementation and evidence

1. Canonical types/flow/config and durable schema; session rotation/reuse/receipts and persistent abuse windows.
2. Official providers + real App Attest/hCaptcha; transaction-safe signup/link/unlink/reauthentication; closed old registration and safe legacy login.
3. API-only activation on same orchestrator with independent internal principal; preserve imported storage and disable new autonomous AI.
4. Outbound consent/restriction gate + atomic operation quota in all adapters/channels/background/fallback; owned complaint handling/moderation.
5. Durable inbox/APNs and account deletion/revocation/restore ledger with fault recovery.
6. Strict proxy/OpenAPI/capability integration, targeted and complete `npm test`; synthetic provider fixtures separate from real device/provider evidence. Root/iOS owner run Swift/build/device tests and gateway rollout. Server update is authorized only after required checks/configuration and a legacy-consent migration plan, with one current rollback and all original storage bindings preserved.

Primary references checked 2026-11-03: [Telegram OIDC](https://core.telegram.org/bots/telegram-login), [Google server authentication](https://developers.google.com/identity/sign-in/ios/backend-auth), [Google SDK nonce API](https://github.com/google/GoogleSignIn-iOS/blob/main/GoogleSignIn/Sources/Public/GoogleSignIn/GIDSignIn.h), [Apple token revocation TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple), [Apple App Attest validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server), [hCaptcha](https://docs.hcaptcha.com/), [APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).
