# Travel Records — Requirements

> Testable statements: **WHEN** (event-triggered), **WHILE** (ongoing state), **IF/THEN** (conditional). IDs are stable; do not renumber on edit.
>
> **Stack (context, not requirements):** Leptos CSR SPA + PWA · CloudFront · Rust on AWS Lambda + API Gateway · DynamoDB (metadata) · S3 (blobs) · Amazon Cognito (user pool; guests are local-only, ADR-0002).

## 1. Onboarding & Authentication
- **REQ-001** — WHEN a user opens the app for the first time, THEN the app SHALL create a local guest identity on the device, without any network call, and allow full use without sign-in (ADR-0002).
- **REQ-002** — WHILE a user is an unsigned guest, the app SHALL allow creating albums, photos, videos, and notes, stored locally.
- **REQ-003** — WHEN a guest attempts to sync to the server or share content, THEN the app SHALL require sign-in/registration via the Cognito user pool before proceeding.
- **REQ-004** — WHEN a user signs in on a device holding guest data, THEN the app SHALL migrate that data to the authenticated account, subject to REQ-056.
- **REQ-005** — IF migration of any guest item on sign-in fails, THEN the app SHALL retain the local copy and retry, and SHALL NOT delete unmigrated local data.
- **REQ-006** — WHEN a signed-in user authenticates on another device, THEN that device SHALL receive the account's albums, notes, and media metadata via sync.
- **REQ-007** — WHEN an access token expires, THEN the app SHALL refresh it transparently while online; IF the sign-in itself has expired, THEN the app SHALL ask the user to sign in again once online (ADR-0009); WHILE offline, the app SHALL continue local-only operation.
- **REQ-054** — WHEN a guest first saves content, THEN the app SHALL request persistent browser storage.
- **REQ-055** — WHILE a guest holds content that exists only on the device, the app SHALL show a non-blocking prompt suggesting sign-in to back it up, and suggesting installing the app IF storage persistence was not granted.
- **REQ-056** — WHEN a guest with content signs in to an account that already has content, THEN the app SHALL show what will be added and ask for confirmation; IF the user cancels, THEN the app SHALL abort the sign-in and leave guest data unchanged.
- **REQ-057** — IF unsynced changes bound to one account exist AND a different account signs in, THEN the app SHALL NOT upload those changes to the new account, and SHALL ask the user to sign in to the original account or discard them.
- **REQ-058** — WHEN a user signs out, THEN the app SHALL warn IF unsynced changes exist (allowing cancel or discard), remove that account's data from the device, and start a fresh guest identity.
- **REQ-083** — WHEN a user signs in or creates an account, THEN the app SHALL do so within the app, without opening another page or site, using the user's email address and a one-time code emailed to it, and SHALL NOT ask for a password (ADR-0009).
- **REQ-084** — IF the app is closed or reloaded while waiting for a sign-in code, THEN on reopening it SHALL return to code entry for as long as that sign-in attempt is valid.
- **REQ-085** — WHILE online, IF the current sign-in will expire within the renewal window, or before the end of a planned or ongoing travel, THEN the app SHALL offer, without blocking, to renew it with a new emailed code.

## 2. Content Model (Albums, Photos, Videos, Notes)
- **REQ-008** — WHEN a user creates an album, THEN the app SHALL assign a client-generated unique ID usable offline.
- **REQ-009** — WHEN a user adds a photo or video, THEN the app SHALL allow an optional caption and association with any number of albums and travels (ADR-0008).
- **REQ-010** — A note SHALL be creatable as (a) a standalone journal entry, (b) a caption on a photo/video, or (c) a note attached to an album.
- **REQ-011** — WHEN a user records a video, IF the clip exceeds 30 seconds, THEN the app SHALL prevent saving it (or require trimming) to enforce the short-video limit.
- **REQ-012** — WHEN any record is created or edited offline, THEN it SHALL persist to local storage immediately without requiring connectivity.
- **REQ-013** — Each record SHALL carry creation and last-modified timestamps, and each of its fields SHALL carry a hybrid logical clock stamp of its last change, sufficient to detect conflicting edits per field (ADR-0004).

## 3. Location & Maps
- **REQ-014** — WHEN a photo/video/note is captured, IF device location is available and permitted, THEN the app SHALL store the geotag with the record.
- **REQ-015** — WHILE viewing their own content, the user SHALL have a map view plotting geotagged records by location.
- **REQ-016** — WHEN content is served via a public link, THEN the app SHALL strip precise geotag/EXIF location data from the publicly served copies.
- **REQ-017** — IF the user denies location permission, THEN capture and saving SHALL still succeed without a geotag.
- **REQ-065** — WHILE viewing an album or travel they are a member of, members SHALL see the same location data as the owner: geotags, the map, and original files with their metadata.
- **REQ-067** — WHEN the server stores a preview, THEN it SHALL remove all embedded metadata not needed to display the image.

## 4. Offline Storage & PWA
- **REQ-018** — The frontend SHALL be an installable PWA whose app shell loads and functions while offline.
- **REQ-019** — All local data (records, metadata, image/video blobs, sync queue) SHALL be stored in IndexedDB.
- **REQ-020** — WHILE offline, the app SHALL allow browsing, creating, and editing all locally available content.
- **REQ-021** — WHEN local storage approaches the browser quota, THEN the app SHALL surface the condition and apply retention rules (§9) rather than failing silently.

## 5. Sync Engine
- **REQ-022** — WHILE offline, the app SHALL durably queue all create/update/delete operations in IndexedDB.
- **REQ-023** — WHEN connectivity is (re)established AND the user is signed in, THEN the app SHALL automatically drain the sync queue without manual action.
- **REQ-024** — The sync engine SHALL transmit in staged priority order: (1) text/notes/metadata, (2) downsized images, (3) full-resolution photos/videos, subject to REQ-052 and REQ-053.
- **REQ-025** — WHEN syncing a photo or video, THEN its downsized preview (for a video, a still frame taken from it) SHALL upload before the corresponding full-resolution original.
- **REQ-026** — WHEN uploading media (preview or original), THEN the client SHALL send it in sequential chunks no larger than the server-advertised maximum (≤4 MiB) and MAY change the chunk size between requests; the server SHALL assemble the chunks into the final S3 object and verify its SHA-256 digest (ADR-0001).
- **REQ-027** — IF a chunked upload is interrupted, THEN on the next sync the app SHALL resume from the last byte offset committed by the server rather than restarting the file.
- **REQ-028** — IF a sync operation fails, THEN the app SHALL retry with backoff and preserve the queued operation until it succeeds or is explicitly cancelled.
- **REQ-029** — WHILE syncing, the app SHALL display sync status/progress to the user.
- **REQ-052** — WHILE measured upload throughput is below the configured threshold, the sync engine SHALL defer full-resolution uploads (lane 3) and continue syncing text and previews.
- **REQ-053** — WHEN the user chooses "upload originals now", THEN the sync engine SHALL start full-resolution uploads regardless of REQ-052; WHEN the user chooses "hold originals", THEN it SHALL NOT upload them until the user releases the hold.
- **REQ-061** — WHILE the app is open and online, it SHALL pull changes when it opens or regains focus, when connectivity returns, after each push, and at a periodic interval.
- **REQ-062** — IF a device's sync position for some content is older than the server's deletion-record retention, THEN the app SHALL resynchronize that content and SHALL NOT discard unsynced local changes.

## 6. Conflict Resolution
- **REQ-030** — WHEN an incoming update changes a field that was changed concurrently since the version the update was based on, THEN the server SHALL flag a conflict for that field rather than silently overwriting; concurrent changes to different fields SHALL be merged.
- **REQ-031** — WHEN a conflict is detected, THEN the app SHALL present both values of each conflicting field, with when each was edited, and prompt the user to choose which to keep.
- **REQ-032** — WHILE a conflict is unresolved, the app SHALL preserve both local and server versions and SHALL NOT discard either.
- **REQ-033** — WHEN the user resolves a conflict, THEN the chosen result SHALL sync to the server and propagate to the user's other devices.
- **REQ-063** — WHEN an edit arrives for an item that was deleted concurrently, THEN the edit SHALL be applied to the item in the trash without prompting, and the editing device SHALL notify the user that the item is in the trash.
- **REQ-064** — IF a sync operation is retried after its result was lost, THEN the server SHALL recognise it as already applied and SHALL NOT report a conflict.

## 7. Sharing & Collaboration
- **REQ-034** — WHEN a signed-in user shares an album with a friend, THEN that friend SHALL gain access per the album's permission (view or contribute).
- **REQ-035** — The app SHALL support a friends graph: sending, accepting, and removing friend relationships between accounts.
- **REQ-036** — WHEN a user generates a public link for an album, THEN anyone with the link SHALL view it without an account.
- **REQ-037** — WHEN a user revokes a public link, THEN subsequent access via that link SHALL be denied.
- **REQ-038** — IF a public link has an expiry AND it has passed, THEN access via that link SHALL be denied.
- **REQ-039** — WHEN a contributor adds a photo/note to a shared album, THEN it SHALL appear to other members after sync.
- **REQ-040** — A contributor SHALL be able to edit/delete only their own contributed items, not items owned by others.
- **REQ-041** — WHILE viewing a shared album via a public link, viewers SHALL NOT see precise location data (per REQ-016).
- **REQ-059** — WHEN a member loses access to an album, THEN the items that member contributed SHALL be removed from the album while staying in the member's personal library, and their devices SHALL delete their local copies of the album's remaining content.
- **REQ-060** — WHEN an owner deletes an album, THEN the app SHALL NOT delete its items; they SHALL stay in their owners' libraries and in any other albums and travels.
- **REQ-066** — WHEN an album or travel is viewed via a public link, THEN photos SHALL be served only as downsized previews and videos only as their still-frame previews and as copies with location metadata removed, and no location data, precise or approximate, SHALL be shown.

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

## 10. Travels
- **REQ-068** — WHEN a user creates a travel, THEN the app SHALL record its title, description, and start and end dates (optionally with times), whether the trip is in the future, in progress or over, and SHALL work offline (ADR-0007).
- **REQ-069** — The user SHALL be able to edit all of a travel's information before, during and after the trip.
- **REQ-070** — A user SHALL be able to have several travels, including travels whose dates overlap; an item SHALL be able to belong to any number of travels, independently of its albums.
- **REQ-071** — WHILE a travel is private, the app SHALL automatically include in it every photo, video and note of the owner whose local capture time falls within the travel's dates; for an item without a capture time, the local time it was added to the app SHALL be used instead.
- **REQ-072** — The owner SHALL be able to remove an automatically included item from a travel and to add items from outside its dates; the app SHALL keep these choices whenever it re-applies REQ-071.
- **REQ-073** — WHEN a travel's dates or an item's capture time change, THEN the app SHALL re-apply REQ-071, subject to REQ-072.
- **REQ-081** — WHEN the owner changes the dates of a private travel that is in progress or finished, THEN the app SHALL first show how many items the new dates will add and remove, and SHALL apply the change only if the owner confirms; items added by hand SHALL NOT be removed.
- **REQ-082** — WHEN the owner changes the dates of a shared or public travel, THEN the app SHALL NOT add or remove items automatically: items that newly qualify SHALL go to their owners for approval (REQ-075), and IF entries fall outside the new dates, THEN the app SHALL offer the owner to remove them.
- **REQ-074** — A travel SHALL be shareable with friends and through public links in the same way as an album; REQ-034–REQ-044, REQ-059 and REQ-066 SHALL apply to travels.
- **REQ-075** — WHILE a travel is shared or has an active public link, the app SHALL NOT add items to it automatically; WHEN an item qualifies under REQ-071, THEN the app SHALL show it full screen, in good resolution, to the item's owner and add it only if the owner approves.
- **REQ-076** — WHEN a private travel is shared or gets a public link, THEN the app SHALL first have the owner review, full screen, every item already in it, and SHALL remove declined items before anyone else can see the travel.
- **REQ-077** — An item declined for a travel SHALL NOT be offered again for that travel, and SHALL NOT be visible to the travel's other members in any form.
- **REQ-078** — WHEN a travel is deleted, THEN the app SHALL NOT delete its items.
- **REQ-079** — WHEN a user creates an album from travels, THEN the app SHALL let the user select one or more travels that are in progress or finished, SHALL offer only the user's own photos, videos and notes from those travels, and SHALL add the chosen items to the new album (ADR-0008).
- **REQ-080** — WHEN a user adds items to an existing album from travels, THEN the app SHALL let the user select one or more travels that are in progress or finished, SHALL offer only the user's own photos, videos and notes from those travels that are not already in the album, and SHALL add the chosen items to it.

## Non-goals (explicitly out of scope)
- Native iOS/Android apps — web PWA only for the POC.
- Real-time collaborative co-editing, and merging concurrent edits within a single field (e.g. text merge). Edits to different fields of a record merge automatically (ADR-0004).
- Audio notes; long-form video (>30 s); video transcoding/adaptive streaming.
- Content moderation, reporting, or takedown of public content.
- Public discovery feed, profiles, search, or a social graph beyond direct friends.
- Full-resolution offline mirror of all content (originals are evicted after upload).
- Editing other users' contributed items in a shared album.
- Automatic network-type detection (Wi-Fi vs cellular/roaming); the manual hold (REQ-053) covers expensive connections.
- Server-side rendering / SEO for app pages (CSR SPA).
- End-to-end encryption of stored media.
