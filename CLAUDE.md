# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

This is an early-stage POC. The repository currently contains only `readme.md` (a product description) and has no commits, source code, or build tooling yet. The `docs/` tree referenced below is planned but does not exist — create files there as the design work begins.

## Product concept

Travel Records saves pictures and notes during travel, organizes them into photo albums, and shares them with friends or publicly. The defining constraint is **offline-first / poor-connectivity operation**: users create albums, add picture descriptions, and write journal entries offline, then sync when a connection is available. Under a bad connection, sync is **staged** — text information first, then downsized pictures (to share quickly), then full-resolution pictures later.

Any architecture or feature work should treat offline operation and staged/resumable sync as primary requirements, not afterthoughts.

## Documentation-driven workflow

Per `readme.md`, this project organizes work around a documentation tree:

- Requirements: `docs/requirements.md`
- Architecture (high-level design): `docs/hld.md`
- Component designs (low-level design): `docs/lld/`
- Acceptance criteria: `docs/ear.md`
- Decisions: `docs/adr/`

Rules to follow:

- When implementing a feature, **read the relevant LLD and `docs/ear.md` first**.
- When a design decision changes, **update the relevant ADR/LLD in the same PR** as the code change.

## Documentation book (PDF)

The docs build into one PDF with mdBook, mdbook-pandoc and typst (`book.toml`, `docs/SUMMARY.md`, `docs/pandoc/`).

- **Add every new document** (LLDs, `docs/ear.md`, new ADRs) to `docs/SUMMARY.md`, or it won't appear in the PDF.
- Build locally with `mdbook build`; the output is `target/book/pdf/travel-records.pdf`. It needs pandoc, typst, mdbook, mdbook-pandoc and Node. Mermaid diagrams are rendered by mermaid-cli, through `npx` or the command in `$MMDC`.
- CI (`.github/workflows/docs.yml`) builds the PDF for pull requests and pushes to `main` that touch the docs, and uploads it as the `travel-records-docs` artifact.
