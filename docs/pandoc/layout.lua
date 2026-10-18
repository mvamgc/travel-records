-- Pandoc filter: page layout for the PDF book.
--
-- * Starts every source document (chapter) on a new page. mdbook-pandoc gives
--   each heading an identifier prefixed with its source file
--   ("…__hld.md__<slug>"), so a change of that prefix marks a chapter start.
-- * Lets table columns size to their content and left-aligns cells, instead
--   of the equal fixed widths pandoc derives from `|---|---|` separators.

local current_file = nil

local function source_file(identifier)
  return identifier:match("^(.*%.md)__")
end

local function header(el)
  local file = source_file(el.identifier)
  if file and file ~= current_file then
    local first = current_file == nil
    current_file = file
    if not first then
      return { pandoc.RawBlock("typst", "#pagebreak(weak: true)"), el }
    end
  end
  return nil
end

local function table_layout(tbl)
  for i, spec in ipairs(tbl.colspecs) do
    local align = spec[1]
    if align == "AlignDefault" then
      align = "AlignLeft"
    end
    tbl.colspecs[i] = { align, nil }
  end
  return tbl
end

return {
  { Header = header, Table = table_layout, traverse = "topdown" },
}
