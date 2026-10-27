# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

An early-stage POC. The design is mostly done; the code is a **walking skeleton**: one thin slice through every layer of ADR-0005, with no product features yet.

- **Done:**
  - requirements, the high-level design, and ADR-0001 to ADR-0010 (all Accepted);
  - the walking skeleton: a Leptos PWA that boots offline and calls `GET /api/health` through CloudFront and API Gateway to the `sync` Lambda; `dev-server`; the CDK stacks; CI and deploy workflows.
- **Next:**
  1. the validation spikes listed at the end of each ADR;
  2. LLDs in `docs/lld/`: data model, sync, media upload, auth/migration (including the sign-in screens of ADR-0009), and the map (ADR-0010);
  3. `docs/ear.md`, pinning the parameter values the ADRs propose;
  4. growing the skeleton: the table (after the data-model LLD), the media bucket, the user pool and the other functions.

## Product concept

Travel Records saves pictures and notes during travel, organizes them into photo albums, and shares them with friends or publicly.

The defining constraint is **offline-first operation over poor connections**. Users create albums, captions and journal entries offline, and the app syncs when a connection is available. Over a bad connection, sync is **staged**: text first, then downsized pictures (so they can be shared quickly), then full-resolution originals later.

Treat offline operation and staged, resumable sync as primary requirements in all work, not afterthoughts. Design for slow, dropping connections and for devices that stay offline for weeks.

## Architecture at a glance

`docs/hld.md` has the full picture; the reasoning behind each choice is in `docs/adr/`.

| Area | Decision | Where |
|---|---|---|
| Client | Leptos CSR PWA (WASM). All local data lives in IndexedDB. An outbox drains in three lanes: text, then previews, then originals. | HLD §2, §4 |
| Media upload | Small resumable chunks through Lambda, addressed by byte offset (`Upload-*` headers), joined by `media-assembler`. | ADR-0001 |
| Identity | Guests are local-only. Guest data migrates on sign-in; sign-out clears the device. | ADR-0002 |
| Sign-in | The app's own screens call Cognito directly: email address plus an emailed one-time code, no passwords, no redirects. Sessions are renewed before they end. A trigger strips Cognito's self-service scope, so the app's tokens can't change the account; no email change in the app. | ADR-0009 |
| Pull sync | Numbered change feeds per sync scope (one personal scope per user, one per album, one per travel). | ADR-0003 |
| Conflicts | Per-field hybrid logical clock stamps; only concurrent edits to the same field conflict. | ADR-0004 |
| Toolchain | Rust workspace, axum on Lambda (arm64), CDK in TypeScript, CloudFront as the single origin, GitHub Actions with OIDC. | ADR-0005 |
| Public links | Photos as previews only; videos as still frames and location-free copies. | ADR-0006 |
| Maps | MapLibre over a self-hosted OpenStreetMap basemap: one PMTiles file in S3, read with range requests. Tiles live in IndexedDB (world overview, viewed places, saved areas). Owners can set, move or remove locations; the server then cleans the original. | ADR-0010 |
| Albums | Items always live in their owner's personal scope. Albums, like travels, hold entries with metadata copies, so an item can be in many albums. | ADR-0008 |
| Travels | Overlapping time-based collections. Private travels auto-add items by local capture time (added time only when there is none); shared and public ones need full-screen approval per item. | ADR-0007 |

## Documentation

| Document | Path | Notes |
|---|---|---|
| Requirements | `docs/requirements.md` | EARS-style statements (WHEN / WHILE / IF … THEN) with IDs `REQ-NNN`. |
| High-level design | `docs/hld.md` | §11 lists every ADR and its status. |
| Decisions | `docs/adr/NNNN-slug.md` | `docs/adr/README.md` introduces them. |
| Component designs | `docs/lld/` | Not written yet. |
| Acceptance criteria | `docs/ear.md` | Not written yet. |

Rules to follow:

- When implementing a feature, **read the relevant LLD and `docs/ear.md` first**.
- When a design decision changes, **update the relevant ADR/LLD in the same PR** as the change. Update the requirements and the HLD in that PR too, if they're affected.
- **Requirement IDs are stable.**
  - Never renumber or reuse an ID.
  - Edit an existing requirement in place.
  - Give a new requirement the next free number (one above the highest existing ID) and put it in the section where it belongs.
- **ADRs:**
  - Number them sequentially.
  - Follow the structure of the existing ones: a header (Status, Date, Resolves, Changes requirements), then Context with decision drivers, Decision, Considered options, Consequences, Parameters, Validation spike and References.
  - List each new ADR in HLD §11 and in `docs/SUMMARY.md`.
  - Concrete values an ADR proposes are pinned later in `docs/ear.md`.
- Before finishing a docs change, check that:
  - every `REQ-NNN` referenced in the HLD and ADRs exists;
  - relative links between documents resolve;
  - `mdbook build` succeeds, which also renders the Mermaid diagrams.

## Documentation book (PDF)

The docs build into one PDF with mdBook, mdbook-pandoc and typst (`book.toml`, `docs/SUMMARY.md`, `docs/pandoc/`).

- **Add every new document** (LLDs, `docs/ear.md`, new ADRs) to `docs/SUMMARY.md`, or it won't appear in the PDF.
- Build locally with `mdbook build`; the output is `target/book/pdf/travel-records.pdf`. It needs pandoc, typst, mdbook, mdbook-pandoc and Node. Mermaid diagrams are rendered by mermaid-cli, through `npx` or the command in `$MMDC`.
- CI (`.github/workflows/docs.yml`) builds the PDF for pull requests and pushes to `main` that touch the docs, and uploads it as the `travel-records-docs` artifact.

## Code layout

ADR-0005 defines the layout. Add each new Lambda or job as a binary in `crates/server/src/bin/`, with its router in the `server` library.

```
Cargo.toml          workspace; rust-toolchain.toml pins Rust and the wasm32 and arm64 targets
crates/shared/      types, sync and upload protocols, HLC (wasm32 and native)
crates/client/      Leptos CSR PWA, built with Trunk; sw.js caches the app shell
crates/server/      axum routers, plus one binary per Lambda and job, plus dev-server
infra/              CDK app (TypeScript); infra/README.md covers first-time AWS setup
```

## Build, run and test

Tools: the Rust toolchain from `rust-toolchain.toml`, Trunk, cargo-lambda 1.9.2 or later with zig (for arm64 builds), and Node 24.

| Task | Command |
|---|---|
| Format, lint | `cargo fmt --all`, `cargo clippy --workspace --exclude client --all-targets -- -D warnings`, and `cargo clippy -p client --target wasm32-unknown-unknown -- -D warnings` |
| Test the Rust code | `cargo test --workspace --exclude client` |
| Run locally | `cargo run -p server --bin dev-server` (port 3000), then `trunk serve` in `crates/client` (port 8080, proxies `/api` to dev-server) |
| Build the PWA | `trunk build --release` in `crates/client` (output in `crates/client/dist`) |
| Test the infrastructure | `npm ci`, then `npx jest` in `infra` |
| Synthesize the stacks | `npx cdk synth --all` in `infra`, after building the PWA. It builds the Lambda binaries for arm64. |

The service worker registers only in release builds, so `trunk serve` never serves a stale cache. To try offline behaviour locally, use `trunk serve --release --no-autoreload`.

CI (`.github/workflows/ci.yml`) runs all of the above on pull requests. `.github/workflows/deploy.yml` deploys dev on merges to `main`, and prod when run by hand; both stay skipped until the AWS setup in `infra/README.md` is done.

## Git workflow

- Work on a branch per change (for example `adr-0007-…` or `lld-sync`) and open a pull request into `main`.
- If a change edits the same lines as an open pull request, branch from that pull request's branch and target it. Retarget to `main` once the base is merged.
