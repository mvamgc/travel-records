# ADR-0006: Location privacy on public links — previews only, location-free video copies

- **Status:** Accepted
- **Date:** 2026-10-14
- **Resolves:** HLD §7 open decision on sanitizing public media (strip on serve vs a pre-generated copy); HLD §11 ADR-0006
- **Changes requirements:** adds REQ-065 to REQ-067

## Context

Anyone with a public link can view an album without an account (REQ-036), and they must not learn where its photos and videos were taken (REQ-016, REQ-041). Location lives in three places:

1. **The record's geotag field** (REQ-014), which is part of the synced metadata.
2. **Inside photo files**, as EXIF GPS data, or in XMP.
3. **Inside video files**, as QuickTime/MP4 location metadata. Some cameras, such as action cameras and drones, also record GPS as a separate data track.

The HLD's two options both assumed public viewers get full-size originals:

- **Strip on serve:** a Lambda filters every public download. Cost grows with every view, and large videos don't stream well through Lambda.
- **Pre-generated copy:** a sanitized copy of every public original. That means extra storage and a server-side image pipeline. iPhone HEIC originals would need converting to JPEG anyway, because only Safari displays HEIC.

More facts:

- Previews are re-encoded by the client (HLD §2), which drops all embedded metadata. The server still can't trust that: a buggy or modified client could upload a preview with GPS data in it.
- Videos have no preview (ADR-0001: lane 2 carries images only), and the POC does no video transcoding (non-goals).
- Album members are friends the owner chose. Only public links are restricted by REQ-016 and REQ-041.

Decision drivers, in priority order:

1. No location reaches public viewers through any of the three places.
2. Safe even if a client misbehaves.
3. No per-view processing, and no server image pipeline for the POC.
4. Small downloads for public viewers.

## Decision

### 1. What public viewers get

| Content | Served to public viewers |
|---|---|
| Record metadata | Title, captions, dates, and the album's structure. **No geotags**, precise or approximate. The `public-viewer` API never returns location fields. |
| Photos | **The preview only** (REQ-066). Full resolution is never served on a public link. |
| Videos | A **location-free copy** of the original, kept under `public/` (decision 3). Until the copy exists, a placeholder is shown. |

There is no map on public pages.

### 2. Previews are cleaned on upload

After a preview's SHA-256 has been checked against `Repr-Digest` (ADR-0001), the server rewrites the file **without re-encoding it**. It keeps only an allowlist of parts (REQ-067):

| Format | Kept | Dropped |
|---|---|---|
| JPEG | image data and tables, JFIF and Adobe markers, the ICC colour profile | EXIF, XMP, IPTC, comments, every other application segment |
| WebP | image data, alpha and animation chunks, the ICC profile | EXIF, XMP, unknown chunks |
| PNG | critical chunks, colour-space and pixel-density chunks | text, EXIF, unknown chunks |

- A preview in any other format is rejected.
- The cleaning runs wherever a preview reaches its final key: in `media` for single-request uploads, and in `media-assembler` for chunked ones.
- The stored file can differ from the client's bytes, so the server records the digest of what it stored.

An allowlist instead of a blocklist means metadata formats nobody anticipated are dropped too.

### 3. Location-free copies of videos

A public copy is made only for a video whose original is `available` and whose album has an active public link.

**How a copy is made.** The `public-media` job reads the original and writes a copy to `public/{itemId}`. Nothing is re-encoded, and every box keeps its size, so no offsets inside the file change:

- QuickTime/MP4 location metadata, such as `©xyz` and the `com.apple.quicktime.location.*` keys, and any XMP, is overwritten in place.
- Only video and audio tracks are kept as they are. Any other track, such as GPS telemetry or timed metadata, is disabled, and its samples are overwritten with zeros in place.

**When copies are made:**

- **Eagerly:** when a public link is created, `sharing` starts the job for every eligible video in the album.
- **Lazily:** anything still missing, such as a video added to the album later, or an original that arrived later (REQ-052, REQ-053), is made the first time a public viewer asks for it. The viewer sees a "preparing video" placeholder until then.

**When copies are deleted:** the daily `purge` job (ADR-0003) deletes copies whose album has no active link, whose link has expired, or whose item has left the album or been deleted.

Revoking a link takes effect at once anyway, because `public-viewer` refuses the token (REQ-037). The presigned URLs it has already issued are short-lived.

### 4. Album members see location

Members see what the owner sees: geotags, the map, and the original files with their metadata (REQ-065). Location filtering applies to public links only.

## Considered options

1. **Strip on serve.** A Lambda filters every public download. Rejected: cost grows with views, and Lambda isn't a good path for streaming large videos.
2. **A pre-generated, location-free copy of every public original, photos included.** Rejected for photos: it needs a server image pipeline (HEIC to JPEG) and extra storage, and public viewers rarely need full resolution. Kept for videos, which have no preview.
3. **Trusting the client's previews without checking.** Rejected: one buggy or modified client could publish GPS data.
4. **Removing location boxes and rebuilding the video file.** Rejected: changing sizes moves every offset in the sample tables, so the whole file must be rewritten correctly. Overwriting in place keeps the file valid without that.
5. **Not showing videos on public links.** Rejected: public albums would lose their videos.
6. **Approximate location for public viewers**, such as a city name or rounded coordinates. Rejected for the POC: nothing requires it, and it reopens the question of what counts as "precise".
7. **Hiding location from members, always or per album.** Rejected: members are chosen by the owner. Hiding it would need location-free copies of originals for members too, and geotags left out of the sync per album.

## Consequences

- **Good:**
  - photos need no copies and no image pipeline;
  - public pages are light, since they serve previews;
  - previews are safe even if a client misbehaves;
  - video copies cost storage only while an album has an active link;
  - nothing runs per view.
- **Bad:**
  - the server needs lossless metadata rewriting for JPEG, WebP and PNG, plus an MP4/QuickTime box walker that can overwrite boxes and track samples in place;
  - public viewers can't see full-resolution photos;
  - the first viewer of a newly added video may see a placeholder;
  - videos are served in their original codec, so a viewer whose browser can't decode it (HEVC in some browsers) can't play it in the page. Transcoding is a non-goal.
- **Follow-ups:**
  - media LLD: the exact allowlists, box and key names, and how the job streams the copy;
  - a test corpus of iPhone, Android and action-camera files with known location data, checked after cleaning.

## Validation spike

1. Clean sample previews (JPEG, WebP, PNG) and check them with `exiftool`: no GPS, EXIF or XMP left, and the images still decode identically.
2. Make copies of iPhone, Android and action-camera videos, and check with `exiftool` and `ffprobe` that no location metadata or telemetry track remains, and that playback works in Safari and Chrome.
3. Time the copy of a 200 MB video in the `public-media` job.

## References

- [HLD](../hld.md) §5, §7, §8, §10; [requirements](../requirements.md) REQ-014, REQ-016, REQ-036–REQ-038, REQ-041, REQ-052, REQ-053, REQ-065–REQ-067.
- [ADR-0001](0001-resumable-media-upload.md) (upload and digest check); [ADR-0003](0003-sync-scopes.md) (purge job); [ADR-0005](0005-toolchain-and-deployment.md) (functions and jobs).
- Apple, *QuickTime File Format* (metadata keys); ISO/IEC 14496-12, *ISO base media file format*; Exif 2.3 / XMP specifications.
