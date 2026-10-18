# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

An early-stage POC, still in the design phase. There is **no application code yet**: the repository holds the design documentation and the tooling that builds it into a PDF.

- **Done:** requirements, the high-level design, and ADR-0001 to ADR-0008 (all Accepted).
- **Next:**
  1. the validation spikes listed at the end of each ADR;
  2. LLDs in `docs/lld/`: data model, sync, media upload, and auth/migration (including the sign-in UI, still open in ADR-0002);
  3. `docs/ear.md`, pinning the parameter values the ADRs propose;
  4. the code scaffolding described in ADR-0005.

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
| Pull sync | Numbered change feeds per sync scope (one personal scope per user, one per album, one per travel). | ADR-0003 |
| Conflicts | Per-field hybrid logical clock stamps; only concurrent edits to the same field conflict. | ADR-0004 |
| Toolchain | Rust workspace, axum on Lambda (arm64), CDK in TypeScript, CloudFront as the single origin, GitHub Actions with OIDC. | ADR-0005 |
| Public links | Photos as previews only; videos as location-free copies. | ADR-0006 |
| Albums | Items always live in their owner's personal scope. Albums, like travels, hold entries with metadata copies, so an item can be in many albums. | ADR-0008 |
| Travels | Overlapping time-based collections. Private travels auto-add items by local capture or added time; shared and public ones need full-size approval per item. | ADR-0007 |

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

## Planned code layout

ADR-0005 defines the layout; none of it exists yet. Follow it when scaffolding, and add the build and test commands here once they exist.

```
Cargo.toml          workspace
crates/shared/      types, sync and upload protocols, HLC (wasm32 and native)
crates/client/      Leptos CSR PWA, built with Trunk
crates/server/      axum routers, plus one binary per Lambda and job, plus dev-server
infra/              CDK app (TypeScript)
```

## Git workflow

- Work on a branch per change (for example `adr-0007-…` or `lld-sync`) and open a pull request into `main`.
- If a change edits the same lines as an open pull request, branch from that pull request's branch and target it. Retarget to `main` once the base is merged.
