// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/agent/tools.json is what the bridge lists to MCP clients before an editor connects; it
// must be exactly the page's tools. `VITRYNE_WRITE_TOOLS=1 pnpm vitest run src/agent/manifest`
// rewrites it after a change to tools.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { toolList } from "./tools";

const file = resolve(import.meta.dirname, "../../../../tools/agent/tools.json");

describe("tools/agent/tools.json", () => {
  it("is the page's tool list", () => {
    const want = `${JSON.stringify(toolList(), null, 2)}\n`;
    if (process.env.VITRYNE_WRITE_TOOLS) writeFileSync(file, want);
    expect(readFileSync(file, "utf8")).toBe(want);
  });
});
