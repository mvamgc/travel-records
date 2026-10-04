# Travel Records — Requirements

> Testable statements: **WHEN** (event-triggered), **WHILE** (ongoing state), **IF/THEN** (conditional). IDs are stable; do not renumber on edit.
>
> **Stack (context, not requirements):** Leptos CSR SPA + PWA · Rust on AWS Lambda + API Gateway · DynamoDB (metadata) · S3 (blobs) · Amazon Cognito (user pools + guest identities).

## 1. Onboarding & Authentication
- **REQ-001** — WHEN a user opens the app for the first time, THEN the app SHALL create a local anonymous (Cognito guest) identity and allow full use without sign-in.
- **REQ-002** — WHILE a user is an unsigned guest, the app SHALL allow creating albums, photos, videos, and notes, stored locally.
- **REQ-003** — WHEN a guest attempts to sync to the server or share content, THEN the app SHALL require sign-in/registration via the Cognito user pool before proceeding.
- **REQ-004** — WHEN a guest signs in for the first time on a device holding local guest data, THEN the app SHALL migrate that local data to the authenticated account.
- **REQ-005** — IF migration of any guest item on sign-in fails, THEN the app SHALL retain the local copy and retry, and SHALL NOT delete unmigrated local data.
- **REQ-006** — WHEN a signed-in user authenticates on another device, THEN that device SHALL receive the account's albums, notes, and media metadata via sync.
- **REQ-007** — WHEN a Cognito session/token expires, THEN the app SHALL refresh it transparently while online, and WHILE offline SHALL continue local-only operation.

## 2. Content Model (Albums, Photos, Videos, Notes)
- **REQ-008** — WHEN a user creates an album, THEN the app SHALL assign a client-generated unique ID usable offline.
- **REQ-009** — WHEN a user adds a photo or video, THEN the app SHALL allow an optional caption and association with zero or one album.
- **REQ-010** — A note SHALL be creatable as (a) a standalone journal entry, (b) a caption on a photo/video, or (c) a note attached to an album.
- **REQ-011** — WHEN a user records a video, IF the clip exceeds 30 seconds, THEN the app SHALL prevent saving it (or require trimming) to enforce the short-video limit.
- **REQ-012** — WHEN any record is created or edited offline, THEN it SHALL persist to local storage immediately without requiring connectivity.
- **REQ-013** — Each content item SHALL carry creation and last-modified timestamps plus a version marker sufficient to detect conflicts.

## 3. Location & Maps
- **REQ-014** — WHEN a photo/video/note is captured, IF device location is available and permitted, THEN the app SHALL store the geotag with the record.
- **REQ-015** — WHILE viewing their own content, the user SHALL have a map view plotting geotagged records by location.
- **REQ-016** — WHEN content is served via a public link, THEN the app SHALL strip precise geotag/EXIF location data from the publicly served copies.
- **REQ-017** — IF the user denies location permission, THEN capture and saving SHALL still succeed without a geotag.

## 4. Offline Storage & PWA
- **REQ-018** — The frontend SHALL be an installable PWA whose app shell loads and functions while offline.
- **REQ-019** — All local data (records, metadata, image/video blobs, sync queue) SHALL be stored in IndexedDB.
- **REQ-020** — WHILE offline, the app SHALL allow browsing, creating, and editing all locally available content.
- **REQ-021** — WHEN local storage approaches the browser quota, THEN the app SHALL surface the condition and apply retention rules (§9) rather than failing silently.

## 5. Sync Engine
- **REQ-022** — WHILE offline, the app SHALL durably queue all create/update/delete operations in IndexedDB.
- **REQ-023** — WHEN connectivity is (re)established AND the user is signed in, THEN the app SHALL automatically drain the sync queue without manual action.
- **REQ-024** — The sync engine SHALL transmit in staged priority order: (1) text/notes/metadata, (2) downsized images, (3) full-resolution photos/videos.
- **REQ-025** — WHEN syncing an image, THEN its downsized preview SHALL upload before the corresponding full-resolution original.
- **REQ-026** — WHEN uploading a full-resolution photo or video, THEN the client SHALL split it into chunks ≤6 MB and POST each through Lambda, which SHALL reassemble them into the S3 object.
- **REQ-027** — IF a chunked upload is interrupted, THEN on the next sync the app SHALL resume from the last acknowledged chunk rather than restarting the file.
- **REQ-028** — IF a sync operation fails, THEN the app SHALL retry with backoff and preserve the queued operation until it succeeds or is explicitly cancelled.
- **REQ-029** — WHILE syncing, the app SHALL display sync status/progress to the user.

## 6. Conflict Resolution
- **REQ-030** — WHEN the server detects an incoming update targeting an item modified concurrently (diverged versions), THEN it SHALL flag a conflict rather than silently overwriting.
- **REQ-031** — WHEN a conflict is detected, THEN the app SHALL present both versions and prompt the user to choose which to keep.
- **REQ-032** — WHILE a conflict is unresolved, the app SHALL preserve both local and server versions and SHALL NOT discard either.
- **REQ-033** — WHEN the user resolves a conflict, THEN the chosen result SHALL sync to the server and propagate to the user's other devices.

## 7. Sharing & Collaboration
- **REQ-034** — WHEN a signed-in user shares an album with a friend, THEN that friend SHALL gain access per the album's permission (view or contribute).
- **REQ-035** — The app SHALL support a friends graph: sending, accepting, and removing friend relationships between accounts.
- **REQ-036** — WHEN a user generates a public link for an album, THEN anyone with the link SHALL view it without an account.
- **REQ-037** — WHEN a user revokes a public link, THEN subsequent access via that link SHALL be denied.
- **REQ-038** — IF a public link has an expiry AND it has passed, THEN access via that link SHALL be denied.
- **REQ-039** — WHEN a contributor adds a photo/note to a shared album, THEN it SHALL appear to other members after sync.
- **REQ-040** — A contributor SHALL be able to edit/delete only their own contributed items, not items owned by others.
- **REQ-041** — WHILE viewing a shared album via a public link, viewers SHALL NOT see precise location data (per REQ-016).

## 8. Social Interaction
- **REQ-042** — WHEN a viewer with access comments on a shared album/photo, THEN the comment SHALL sync and become visible to other members.
- **REQ-043** — WHEN a viewer reacts to a shared album/photo, THEN the reaction SHALL sync and be counted/displayed.
- **REQ-044** — WHEN the owner deletes the album or revokes a viewer's access, THEN associated comments/reactions SHALL no longer be accessible to removed viewers.

## 9. Deletion, Trash & Local Retention
- **REQ-045** — WHEN a user deletes a record, THEN it SHALL be soft-deleted (tombstoned) and moved to Trash, not immediately removed.
- **REQ-046** — A tombstone SHALL propagate via sync so the deletion reflects on all of the user's devices and on the server.
- **REQ-047** — WHILE an item is in Trash AND within the retention window, the user SHALL be able to restore it.
- **REQ-048** — WHEN an item's trash-retention window elapses, THEN it SHALL be permanently purged locally and on the server.
- **REQ-049** — WHEN a full-resolution photo/video is confirmed uploaded, THEN the app SHALL evict the local original and retain only the downsized preview.
- **REQ-050** — WHEN a user opens content whose full-resolution original is not local, IF online, THEN the app SHALL re-download the original on demand.
- **REQ-051** — IF offline and the full-resolution original was evicted, THEN the app SHALL display the downsized preview and indicate the original is available when online.

## Non-goals (explicitly out of scope)
- Native iOS/Android apps — web PWA only for the POC.
- Real-time collaborative co-editing / CRDT auto-merge of the same item.
- Audio notes; long-form video (>30 s); video transcoding/adaptive streaming.
- Content moderation, reporting, or takedown of public content.
- Public discovery feed, profiles, search, or a social graph beyond direct friends.
- Full-resolution offline mirror of all content (originals are evicted after upload).
- Editing other users' contributed items in a shared album.
- Wifi-only / data-saver network policies (sync runs on any connection).
- Server-side rendering / SEO for app pages (CSR SPA).
- End-to-end encryption of stored media.
