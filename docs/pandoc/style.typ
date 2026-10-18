// Typst styling for the PDF book, included in the header of pandoc's typst template.

// Code blocks: smaller text so ~90-column layouts (e.g. directory trees) fit
// the page width, on a light background.
#show raw.where(block: true): it => {
  set text(size: 8pt)
  block(fill: luma(246), inset: 6pt, radius: 2pt, width: 100%, it)
}
