-- Pandoc filter: render ```mermaid code blocks to PNG images with mermaid-cli.
--
-- Uses `mmdc` from $MMDC if set (e.g. MMDC=mmdc in CI), otherwise runs
-- mermaid-cli through npx. Rendered images are cached by content hash in
-- $MERMAID_CACHE (default: target/book/mermaid), so unchanged diagrams are
-- not re-rendered.

local MMDC_PACKAGE = "@mermaid-js/mermaid-cli@11.4.2"
local cache_dir = os.getenv("MERMAID_CACHE") or "target/book/mermaid"
local puppeteer_config = "docs/pandoc/puppeteer-config.json"

local function file_exists(path)
  local f = io.open(path, "rb")
  if f then
    f:close()
    return true
  end
  return false
end

local function render(source, output)
  local input = output:gsub("%.png$", ".mmd")
  local f = assert(io.open(input, "w"))
  f:write(source)
  f:close()

  local args = {
    "-i", input, "-o", output,
    "-b", "white", "-s", "3",
    "-p", puppeteer_config,
    "-q",
  }
  local mmdc = os.getenv("MMDC")
  if mmdc then
    pandoc.pipe(mmdc, args, "")
  else
    local npx_args = { "-y", "-p", MMDC_PACKAGE, "mmdc" }
    for _, a in ipairs(args) do
      table.insert(npx_args, a)
    end
    pandoc.pipe("npx", npx_args, "")
  end
end

function CodeBlock(block)
  if not block.classes:includes("mermaid") then
    return nil
  end
  pandoc.system.make_directory(cache_dir, true)
  local output = cache_dir .. "/" .. pandoc.utils.sha1(block.text) .. ".png"
  if not file_exists(output) then
    render(block.text, output)
  end
  local image = pandoc.Image({}, output, "", { width = "100%" })
  return pandoc.Para({ image })
end
