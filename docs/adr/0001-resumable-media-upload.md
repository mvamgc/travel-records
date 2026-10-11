# ADR-0001: Resumable media upload in small chunks through Lambda

- **Status:** Accepted
- **Date:** 2026-10-08
- **Resolves:** HLD §7 open decision on chunk assembly
- **Changes requirements:** amends REQ-024, REQ-026, REQ-027; adds REQ-052, REQ-053

## Context

Every photo or video is uploaded in two representations (HLD §7): a downsized **preview** first (lane 2) and the full-resolution **original** later (lane 3) (REQ-024, REQ-025). Uploads must survive very slow, frequently dropping connections and resume where they stopped (REQ-026, REQ-027). All API traffic goes through API Gateway (HTTP API) to Rust Lambdas (HLD §5).

These facts constrain the design:

- **API Gateway hands Lambda only complete requests.** Lambda runs after the gateway has received the whole body. A request cut off mid-body is lost entirely, so chunk size sets how many bytes a dropped connection wastes.
- **Lambda accepts at most 6 MB per request, and binary bodies arrive base64-encoded.** An HTTP API base64-encodes non-text bodies for Lambda (×4/3), so a raw chunk must stay under about 4.4 MB.
- **S3 multipart parts must be at least 5 MiB** (except the last). "One chunk = one multipart part" through Lambda is therefore impossible. HLD §7 had named that option the leading candidate.
- **"Good" connections while travelling are still flaky**, and the user can force originals to upload over a poor link (REQ-053). Originals need small chunks too.

Decision drivers, in priority order:

1. Small chunks, whose size can change mid-upload (shrink after an interrupted request).
2. Safe retries: any request can be repeated after a lost response without corrupting or duplicating data.
3. Resume after an app restart or weeks offline, using only what the client keeps in its outbox.
4. One mechanism for previews and originals.
5. Serverless, scale-to-zero, Rust (HLD §5, §10).

## Decision

### 1. Chunks go through the `media` Lambda and are staged in S3

The client sends each chunk through API Gateway to the `media` Lambda, which stores it as its own S3 object at `staging/{uploadId}/{offset}-{length}`. The key holds both offset and length, so two attempts at the same offset with different chunk sizes never overwrite each other.

### 2. Sequential appends, addressed by byte offset

`Upload-Offset` is a byte offset into the file, never a part number, so the client can change chunk size between any two requests. Each append must start exactly where the committed bytes end. Per upload, the server keeps the committed offset and the list of committed chunks.

The commit point is a DynamoDB conditional update (`offset = :expected`) that advances the offset and records the chunk. The S3 write happens first. A chunk object whose commit failed is garbage and is removed by the staging lifecycle rule. An append at any other offset gets `409 Conflict` with the current `Upload-Offset`, and the client continues from there.

Example, with the client shrinking chunks after a drop:

1. `PATCH` 1 MiB at offset 4 194 304. The connection drops mid-body, so nothing is committed.
2. `PATCH` 256 KiB at offset 4 194 304 → `204`, `Upload-Offset: 4456448`.
3. If step 1 had in fact been committed and only its response was lost, step 2 gets `409` with `Upload-Offset: 5242880`, and the client resumes from there. `HEAD` gives the same answer at any time, for example after an app restart.

### 3. Parallel across files, never within a file

The client uploads up to three files at once, each one sequentially. It drops to one file at a time when interruptions increase. On a link short of bandwidth, parallel streams inside one file add no throughput. They also make each chunk take longer, so more chunks get cut off. Parallel *files* still keep the link busy during each request's round trip, and on lossy, high-latency links they give several connections.

### 4. Creation is item-scoped and idempotent

An upload is created with `POST /items/{itemId}/media/{kind}`, where `kind` is `preview` or `original`.

- If an upload for that item and kind is in progress with the same `Upload-Length` and `Repr-Digest`, the server returns it with its current offset. A retried POST never leaves an orphaned upload.
- If that media is already `available`, the server says so.
- A different length or digest gets `409`.

File name and media type come from the item record, which lane 1 has already synced. The item must exist on the server before its media upload starts.

### 5. Assembly

- **Single-request uploads** (the creation request carries the whole file): the `media` Lambda checks the SHA-256 in memory and writes the final object (`original/…` or `preview/…`) directly. There is no staging and no assembly. Most previews take this path.
- **Multi-chunk uploads:** when the last chunk commits, the `media` Lambda invokes the **`media-assembler`** Lambda asynchronously. The assembler:
  1. streams the committed chunks in order into an S3 multipart upload with 16 MiB parts, computing SHA-256 as it goes;
  2. compares the hash with `Repr-Digest`;
  3. completes the multipart upload and marks the media `available`;
  4. deletes the staged chunks.

  A hash mismatch marks the upload `failed`, and the client starts over. Failed invocations use Lambda's async retries and an on-failure destination. A scheduled sweep re-triggers uploads stuck in `assembling`.

### 6. "Confirmed uploaded" means `available`

The client evicts a local original (REQ-049) only after the server reports that media `available`, meaning assembled and hash-checked. Having sent all the bytes is not enough. Media state is part of the item record and reaches the client through pull sync.

### 7. Expiry and cleanup

- Each upload expires a fixed time after creation (DynamoDB TTL). Requests to an expired upload get `410 Gone`, and the client starts a new upload. It always can, because originals are evicted only once `available`.
- The S3 lifecycle rule on `staging/` expires objects later than any upload can live, so chunks never disappear under a live upload.
- An abort-incomplete-multipart-upload lifecycle rule cleans up after crashed assemblies.

### 8. Every request is authenticated on its own

Each request carries the Cognito JWT and is authorized independently. The caller must own the item, or be a contributor uploading their own item. A token refreshed partway through an upload simply applies from the next chunk (REQ-007).

## Protocol

Header names follow the IETF draft *Resumable Uploads for HTTP* (draft-ietf-httpbis-resumable-upload-13) where it defines one. Digests use RFC 9530, and error bodies use RFC 9457 problem details. This is not a full implementation of the draft:

- there is no `104` interim response, which API Gateway cannot send;
- the server knows the upload is complete from `Upload-Length`, so the client doesn't send `Upload-Complete`.

### Create: `POST /items/{itemId}/media/{kind}`

| Header | Required | Meaning |
|---|---|---|
| `Upload-Length` | yes | Total file size in bytes. |
| `Repr-Digest` | yes | SHA-256 of the whole file, `sha-256=:<base64>:`. |
| `Content-Length` | yes | Bytes in this request's body. 0 is allowed. |
| `Content-Type` | if there is a body | `application/partial-upload`. |
| `Content-Digest` | no | SHA-256 of this request's body. |

The body, if present, is the file's bytes starting at offset 0. Uploading a whole file in one request is simply a creation request whose `Content-Length` equals `Upload-Length`.

Responses:

- `201 Created` for a new upload. Headers: `Location: /uploads/{uploadId}`, `Upload-Offset`, `Upload-Length`, `Upload-Complete`, `Upload-Limit`.
- `200 OK` when a matching upload already exists (same headers as `201`), or when the media is already available (`Upload-Complete: ?1`).
- `409 Conflict` when the item already has media of this kind with a different length or digest.
- `404 Not Found` when the server doesn't know the item yet.

### Append: `PATCH /uploads/{uploadId}`

| Header | Required | Meaning |
|---|---|---|
| `Upload-Offset` | yes | Byte offset where this body starts. Must equal the server's committed offset. |
| `Content-Length` | yes | Chunk size. At most `max-append-size`; at least `min-append-size` unless it is the last chunk. |
| `Content-Type` | yes | `application/partial-upload`. |
| `Content-Digest` | no | SHA-256 of the chunk. |

Responses:

- `204 No Content` with the new `Upload-Offset` and `Upload-Complete`. After the last chunk, `Upload-Complete` is `?1` and assembly starts.
- `409 Conflict` with the current `Upload-Offset` when the offset doesn't match (problem type `mismatching-upload-offset`).
- `413 Content Too Large` when the chunk exceeds `max-append-size`.
- `400 Bad Request` when `Content-Digest` doesn't match, or the chunk would run past `Upload-Length`.
- `410 Gone` when the upload has expired.

### Status: `HEAD /uploads/{uploadId}`

Returns `Upload-Offset`, `Upload-Length`, `Upload-Complete` and `Upload-Limit`. The client uses it to resume after a lost response or an app restart.

### Cancel: `DELETE /uploads/{uploadId}`

Discards the upload and its staged chunks. Returns `204`.

### Server limits: `Upload-Limit`

Sent with creation and `HEAD` responses, for example:

```
Upload-Limit: max-size=536870912, max-append-size=4194304, min-append-size=65536, max-age=2592000
```

The client picks chunk sizes within these limits.

### Changes from the initial proposal

| Proposal | Decision | Why |
|---|---|---|
| `X-TP-` headers | Standard names (`Upload-Length`, `Upload-Offset`, …) | RFC 6648 deprecates the `X-` prefix, and the IETF draft already defines these names. |
| Different header sets for a full-file POST and a chunk POST | One creation request; the body is optional and always starts at offset 0 | A full-file upload is just the case `Content-Length == Upload-Length`. |
| `X-TP-Offset` on POST | No offset on POST | A new upload always starts at 0. |
| `Md5` and `Sha-256`, both optional | `Repr-Digest` (SHA-256) required; `Content-Digest` optional per chunk | MD5 adds nothing over SHA-256, and the server must verify the assembled file. |
| `File-Name` and file `Content-Type` headers | Taken from the item record | Lane 1 has already synced the item's metadata. |
| `PUT` to append | `PATCH` with `application/partial-upload` | `PUT` means "replace the whole resource". The draft defines this media type for appends. |
| POST always creates a new upload | Item-scoped, idempotent creation | A POST retried after a lost response must not create a second upload. |
| — | `HEAD`, `DELETE`, `Location` | Needed to resume after a lost response, to cancel, and to address the upload. |

## Client policy

- **Chunk size:** chosen so each request takes about 10 s at the measured throughput. Halved after an interrupted request, grown after several successes, always within `Upload-Limit`.
- **Concurrency:** up to three files at once. Drops to one when interruptions increase and goes back up when they settle.
- **Lanes:** text and metadata first, then previews, then originals (REQ-024). Originals wait until measured throughput is above a threshold (REQ-052), unless the user starts or holds them manually (REQ-053).
- **Order within an item:** the item record syncs before its media upload starts. The preview uploads before the original (REQ-025).
- **Outbox state:** per upload, the outbox keeps the item ID, the kind and, once received, the `Location`. That is enough to resume with `HEAD`, or to repeat the idempotent POST if no `Location` ever arrived.

## Parameters

Initial values, to be pinned in `docs/ear.md`:

| Parameter | Initial value | Basis |
|---|---|---|
| Max chunk (`max-append-size`) | 4 MiB | Base64 makes it ≈ 5.33 MiB; with the event envelope that stays under Lambda's 6 MB limit. |
| Min chunk (`min-append-size`), except the last | 64 KiB | Bounds S3 request cost: about 16 k staging PUTs per GiB, ≈ $0.08/GiB at 64 KiB. |
| Max file (`max-size`) | 512 MiB | A 30 s 4K clip (REQ-011) with headroom. |
| Target request duration | ~10 s | Short enough to finish between drops on a flaky link. |
| Max concurrent files | 3 | See decision 3. |
| Upload lifetime (`max-age`) | 30 days | Travellers may go weeks between good connections. |
| `staging/` lifecycle expiry | 45 days | Longer than any upload can live. |
| Abort incomplete multipart uploads | 7 days | Cleanup after crashed assemblies. |
| Assembly part size | 16 MiB | Above the 5 MiB S3 minimum; 512 MiB is 32 parts. |
| Originals throughput threshold | TBD | REQ-052. Set after the validation spike. |

## Considered options

1. **S3 multipart through Lambda, one chunk per part.** Infeasible: parts must be at least 5 MiB, but chunks can't exceed about 4.4 MB through Lambda.
2. **Presigned URLs, with the client uploading multipart parts straight to S3.** Bytes cost no Lambda time, S3 does the assembly, and the client can resume using S3's list of received parts. Rejected because parts must be at least 5 MiB: at 256 kbit/s one part takes about 2.7 minutes and is lost whole if the connection drops. Kept as a possible later fast path for originals uploaded over good connections.
3. **tus 1.0, wire-compatible.** A mature spec with test tools. Rejected because:
   - every request needs `Tus-Resumable`;
   - `Upload-Metadata` values are base64-encoded;
   - creation isn't idempotent;
   - tus client libraries keep their own resume state, which would clash with the IndexedDB outbox in a Rust/WASM client.
4. **Out-of-order byte ranges.** Would allow parallel parts within a file. Rejected: no throughput gain on a link short of bandwidth, and the server must track a set of ranges. If a single large video on a lossy, high-latency link ever needs parallelism, a file can be split into a few byte-range segments, each uploaded sequentially, then joined at assembly. tus's concatenation extension works this way. Not designed now.
5. **S3 Express One Zone appendable objects.** Append in place with no assembly. Rejected for the POC: it needs a separate bucket class (directory buckets) and stores data in a single Availability Zone.
6. **Self-hosted tus server (tusd) on ECS/Fargate.** Rejected: not scale-to-zero, not Rust, and a second runtime to operate.

## Consequences

- **Good:**
  - chunks can be as small as 64 KiB and change size on every request;
  - any request can be retried safely;
  - resuming needs only `HEAD`;
  - one mechanism serves previews and originals;
  - previews sent in a single request are available immediately.
- **Bad:**
  - custom code to stage, commit and assemble chunks, plus a second function (`media-assembler`);
  - media uploaded in several chunks becomes available only after async assembly;
  - S3 request cost grows as chunks shrink;
  - every byte passes through Lambda, costing invocation time that a direct-to-S3 upload wouldn't.
- **Follow-ups:**
  - `docs/lld/media-upload.md`: DynamoDB upload and chunk records, state machine, full error catalogue;
  - parameter values in `docs/ear.md`.

## Validation spike

Before writing the LLD, check on real AWS:

1. A 4 MiB binary `PATCH` through the HTTP API reaches Lambda within the payload limit.
2. A throttled client (`curl --limit-rate 16k`) sending a 4 MiB chunk isn't cut off by a gateway timeout while the body is still arriving. If it is, cap chunk size by duration as well as bytes.
3. The assembler handles a 512 MiB file made of 64 KiB chunks (8 192 objects) within Lambda's time and memory limits.
4. Whether browsers send parallel requests to API Gateway over separate connections or multiplex them over one HTTP/2 connection.

## References

- [HLD](../hld.md) §4, §5, §7; [requirements](../requirements.md) REQ-024–REQ-027, REQ-049, REQ-052, REQ-053.
- IETF draft-ietf-httpbis-resumable-upload-13, *Resumable Uploads for HTTP*, October 2026.
- tus resumable upload protocol 1.0: <https://tus.io/protocols/resumable-upload>
- RFC 9530 *Digest Fields*; RFC 9457 *Problem Details for HTTP APIs*; RFC 6648 *Deprecating the "X-" Prefix*; RFC 5789 *PATCH Method for HTTP*.
