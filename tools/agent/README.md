# Assistant bridge

Lets an assistant edit the design open in the Vitryne editor while the person watches the 3D
garment change. "Make it navy fleece" or "give the sleeves a grey contrast" become the same
commands the editor's own buttons run: checked, validated by Rust, re-draped, one undo step each,
labelled "(assistant)".

```
Hermes / MCP client ──stdio── hermes-bridge.mjs ──SSE + POST, 127.0.0.1── editor tab (?agent=7341)
```

## Use

```sh
node tools/agent/hermes-bridge.mjs            # MCP on stdio, HTTP on 127.0.0.1:7341
```

Open the editor with `?agent=7341` (for example `http://localhost:5173/example/tshirt?agent=7341`).
A pill at the bottom right says when the assistant is connected and what it last did. `?agent=off`
turns it off for the tab.

Hermes (`~/.hermes/config.yaml`):

```yaml
mcp_servers:
  vitryne:
    command: node
    args: [/path/to/vitryne/tools/agent/hermes-bridge.mjs]
```

Without MCP, `POST /agent/call` with `{"tool": "set_fabric_color", "args": {"color": "navy"}}`
answers `{"ok": true, "result": ...}` or `{"ok": false, "error": "..."}`.

## Tools

`tools.json` lists them (generated from `packages/vitryne-web/src/agent/tools.ts`; a test fails if
it is stale, `VITRYNE_WRITE_TOOLS=1 pnpm vitest run src/agent/manifest` rewrites it):

| Tool | Does |
| --- | --- |
| `describe_design` | The garment, pieces, fabrics and colours, undo/redo labels, accepted kinds and colours |
| `set_fabric_kind` | jersey, denim, poplin, fleece or wool suiting physics (re-drapes) |
| `set_fabric_color` | `#rrggbb` or a swatch name |
| `tune_fabric` | one physical value, to a value or by a factor |
| `add_fabric` | a new fabric of a kind and colour, for contrast pieces |
| `use_fabric_for_piece` | cut a piece (all its copies) from a fabric |
| `set_garment_fabric` | the garment's main fabric |
| `rename_project`, `undo`, `redo` | as the editor's |

## What it will not do

Sew, place pieces on the body, measure or grade. Those stay with the person
([Patent warnings](../../packages/vitryne-docs/content/docs/developers/patents.md), rules 3 and 4:
no placement fed into sewing, no learned model choosing where pieces go).

## Privacy

The page only connects when its URL asks for it, only to `127.0.0.1`, and only answers calls the
bridge sends. The bridge refuses connections from pages other than localhost and
`https://vitryne.app` (add more with `--origin`). Nothing leaves the machine.

## Tests

- `pnpm vitest run src/agent` (web package): every tool against the real T-shirt and the real
  document store; Rust validates each resulting state.
- `make agent-bridge`: the bridge over MCP and HTTP against a stand-in editor.
