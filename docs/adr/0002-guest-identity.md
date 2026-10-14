# ADR-0002: Local-only guest identity and device account lifecycle

- **Status:** Accepted
- **Date:** 2026-10-12
- **Resolves:** HLD §3 note on the guest identity; HLD §11 ADR-0002
- **Changes requirements:** amends REQ-001, REQ-004; adds REQ-054 to REQ-058

## Context

The app must be fully usable without an account (REQ-001, REQ-002), while syncing and sharing need a signed-in Cognito user (REQ-003). REQ-001 asked for a "Cognito guest" identity, and HLD §3 had already assumed a local-only guest pending this decision. Nothing so far said what happens when the account on a device changes: signing out, or signing in as someone else.

These facts constrain the design:

- **Creating a Cognito identity needs the network.** The first open after installing the app may happen offline, for example on a plane, and connections while travelling are often poor. An identity that needs a server round trip can't be created on time.
- **Guests never talk to the server.** REQ-003 rules out syncing and sharing before sign-in, so a guest has nothing to authenticate for.
- **Guest content exists only on the device.** It can be lost with the device, or if the browser clears the site's storage. Safari in particular may clear storage for sites that aren't installed.
- **One device can see several accounts over time.** Unsynced changes must always reach the account they were made under.

Decision drivers, in priority order:

1. Never block on the network. That covers the first launch, and every later moment.
2. Don't lose guest content: never during migration (REQ-005), and as far as the browser allows before sign-in.
3. No server access for unauthenticated users, apart from public links (REQ-036).
4. One way to authenticate API calls: the Cognito JWT checked by API Gateway (HLD §3, §5).
5. Correct ownership whenever the account on a device changes.

## Decision

### 1. Three identities on a device

| Identity | What it is | Lifetime |
|---|---|---|
| **Device ID** | Random UUID generated at first launch. Keys the per-device sync cursor (HLD §4). | The installation. It survives sign-in and sign-out. |
| **Local profile** | Owner of all local data. Exactly one per device: either a **guest** (with a local UUID) or **bound** to an account. | From creation until sign-out. |
| **Account** | A Cognito user-pool user, identified by its `sub`. | Server-side and permanent. |

The server takes ownership from the JWT's `sub` and never trusts an owner field sent by the client.

### 2. Guest creation

On first launch, if there is no profile, the app creates a guest profile locally, with no network call. Records created by the guest carry `ownerId = guest:{uuid}`.

### 3. Protecting guest content

- When the guest first saves content, the app calls `navigator.storage.persist()` and remembers the result (REQ-054).
- If persistence isn't granted, a banner suggests installing the app or signing in.
- While the guest has content that exists only on the device and the device is online, the app shows a sign-in prompt. The prompt never blocks local use (REQ-055), and its trigger is pinned in `docs/ear.md`.

This reduces the risk of losing guest content but can't remove it. Only signing in does.

### 4. No outbox while a guest

A guest's changes update IndexedDB only; nothing goes into the outbox. At migration (decision 5), the client queues **one create per guest entity, with its current state**, followed by the media uploads (previews before originals, per ADR-0001). Weeks of guest edit history are never replayed over a slow link. Items in the trash migrate as trashed, so the retention window still applies (REQ-047).

### 5. Migration on sign-in

1. After the user authenticates, the client asks the server whether the account already has content. The exact call is defined in the auth/migration LLD.
2. **Account already has content:** the client shows a confirmation built from local counts, for example "Add 3 albums, 120 photos and 8 notes from this device to anna@example.com?" (REQ-056). **Cancel** aborts the sign-in: the client discards the new tokens, revokes the refresh token if online, and stays a guest with its content untouched.
3. **Account is empty:** migration goes ahead without asking.
4. In a single IndexedDB transaction, the client changes `ownerId` on every guest record to the account's `sub`, binds the profile to that `sub`, and queues the creates.
5. Normal sync drains the queue in its usual lanes. Client-generated IDs make every create safe to retry, and local data is kept until it has synced (REQ-005).

Sign-in always happens online, because Cognito needs the network. Once the creates are queued, migration continues across offline periods like any other sync work.

### 6. Account binding

Once a profile is bound, its `sub` never changes. If a different account signs in on the device, for example after the refresh token expired and the user picked another account:

- **with unsynced changes on the device:** the app refuses and says "Unsynced changes belong to anna@example.com. Sign in as anna@example.com, or discard them." It never uploads them to the new account (REQ-057);
- **without unsynced changes:** the app treats it as signing out (decision 7) and then signing in.

### 7. Sign-out

1. If the outbox isn't empty, the app warns with the number of unsynced changes and offers **Cancel** or **Sign out and discard** (REQ-058).
2. If online, it revokes the refresh token. This is best effort; sign-out also works offline.
3. It deletes all of the account's local data: records, media blobs, outbox, sync cursor and any cached media.
4. It creates a fresh guest profile. The device ID stays.

### 8. Tokens

- Access and ID tokens are kept in memory. The refresh token is stored in IndexedDB with the profile. For the POC this accepts some exposure to cross-site scripting, which a strict Content Security Policy mitigates.
- The refresh-token lifetime must outlast a long trip without connectivity; the value goes in `docs/ear.md`.
- When the refresh token expires, the user signs in again, and it must be the same account (decision 6). Until then the app keeps working locally (REQ-007).

## Considered options

1. **Cognito Identity Pool unauthenticated identity**, as REQ-001 originally said. Rejected:
   - getting the identity needs the network, so an offline first launch can't create it;
   - it hands guests temporary AWS credentials that no requirement uses;
   - it adds AWS-signed requests as a second way to authenticate API calls.
2. **Silent anonymous account in the user pool**, created the first time the app is online and upgraded later by adding an email. Guest content would be backed up before registration, removing the main risk of decision 3. Rejected:
   - it contradicts REQ-003;
   - every guest becomes a billable Cognito user;
   - abandoned accounts pile up.
3. **Queueing guest changes in the outbox and replaying them at migration.** Rejected: it sends edit history nobody needs over slow links, while a snapshot of current state carries the same result.
4. **Always merging guest content silently.** Rejected: signing in to the wrong account (a partner's, say) would move the content there.
5. **Keeping account data hidden on the device after sign-out**, for a faster return. Rejected: it needs separate storage per account and leaves personal data on shared devices.

## Consequences

- **Good:**
  - the app works offline from the very first launch;
  - guests need no AWS resources, and the server never sees unauthenticated traffic except public links;
  - API calls have a single authentication path.
- **Bad:**
  - guest content can be lost until the user signs in. The protections reduce this risk but don't remove it;
  - guests get nothing across devices;
  - migration (snapshot, re-stamping, confirmation) is its own piece of code;
  - sign-out can discard unsynced changes once the user confirms.
- **Follow-ups:**
  - auth/migration LLD: the account-content check, migration batching, and the sign-in UI;
  - parameter values in `docs/ear.md`.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Sign-in prompt trigger | TBD | For example, the first album or a number of items. Decide with UX. |
| Refresh-token lifetime | 90 days | Covers long trips offline. Cognito allows from 60 minutes up to 10 years. |

## Validation and open items

1. Whether Safari and the app installed to the iOS home screen really keep separate storage. If they do, show an "install first" hint before a guest in Safari creates content, because that content won't follow them into the installed app.
2. How `navigator.storage.persist()` behaves in each target browser: granted silently, prompted, or refused.
3. The sign-in flow inside an installed app, especially iOS standalone mode: Cognito's hosted login page via redirect (authorization code with PKCE) vs an in-app form. To be decided in the auth/migration LLD.

## References

- [HLD](../hld.md) §2, §3, §4, §11; [requirements](../requirements.md) REQ-001 to REQ-007, REQ-054 to REQ-058.
- [ADR-0001](0001-resumable-media-upload.md): resumable media upload, used by migration for media.
- MDN, *StorageManager: persist() method*.
