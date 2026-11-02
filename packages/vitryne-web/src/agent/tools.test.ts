// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DocumentStore, type Engine } from "@/document/store";
import { mainGarment } from "@/document/entities";
import { cutColor, cutFabric } from "@/document/commands";
import { DENIM, FLEECE } from "@/format/presets";
import { openExample, rustRefuses } from "@/test/rust";
import { AGENT_TOOLS, callTool, findColor, findKind, toolList } from "./tools";

/** An engine that accepts every state at once (Rust's verdict is checked separately). */
const engine: Engine = {
  update: () => Promise.resolve({ warnings: [] }),
  drape: () => {},
  onReopened: () => {},
};

function setup() {
  const store = new DocumentStore(engine, { freeze: true, drapeDelayMs: 5 });
  const { file, entities } = openExample("tshirt");
  store.load("tshirt.vtry", entities, [], 0);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    callTool(store, name, args);
  const accepted = () => rustRefuses(file, store.state.entities);
  return { store, call, accepted };
}

function ok(r: ReturnType<typeof callTool>) {
  if (!r.ok) throw new Error(`tool failed: ${r.error}`);
  return r.result as Record<string, unknown>;
}

describe("agent tools", () => {
  it("lists every tool with an object schema, under unique names", () => {
    const list = toolList();
    expect(new Set(list.map((t) => t.name)).size).toBe(AGENT_TOOLS.length);
    for (const t of list) expect(t.inputSchema.type).toBe("object");
  });

  it("describes the T-shirt by names, fabrics and colours", () => {
    const { call } = setup();
    const d = ok(call("describe_design")) as {
      garment: { name: string; pieces: { name: string; cuts: unknown[] }[] };
      fabrics: { name: string }[];
    };
    expect(d.garment.name).toBe("T-shirt (Teagan)");
    expect(d.garment.pieces.map((p) => p.name)).toEqual([
      "front",
      "back",
      "sleeve",
    ]);
    expect(d.garment.pieces[2]!.cuts).toHaveLength(2);
    expect(d.fabrics).toHaveLength(1);
  });

  it("turns the main fabric into denim in one undo step, which Rust accepts", () => {
    const { store, call, accepted } = setup();
    const r = ok(call("set_fabric_kind", { kind: "jeans" }));
    expect(r.done).toBe("Make it denim (assistant)");
    const f = store.state.entities.fabrics[0]!;
    expect(f.stretch).toEqual(DENIM.stretch);
    expect(f.category).toBe("woven");
    expect(accepted()).toBeNull();
    expect(store.state.undoLabel).toBe("Make it denim (assistant)");
    ok(call("undo"));
    expect(store.state.entities.fabrics[0]!.category).toBe("knit");
    expect(store.state.dirty).toBe(false);
  });

  it("recolours by swatch name and by hex", () => {
    const { store, call, accepted } = setup();
    ok(call("set_fabric_color", { color: "Navy" }));
    const e = store.state.entities;
    const g = mainGarment(e)!;
    expect(cutColor(e, g, g.pieces[0]!.cuts[0]!)).toBe("#1f2a44");
    ok(call("set_fabric_color", { color: "#2340D8" }));
    const e2 = store.state.entities;
    expect(cutColor(e2, mainGarment(e2)!, g.pieces[1]!.cuts[0]!)).toBe(
      "#2340d8",
    );
    expect(accepted()).toBeNull();
  });

  it("gives both sleeves a contrast fleece, leaving the body alone", () => {
    const { store, call, accepted } = setup();
    const added = ok(
      call("add_fabric", { kind: "fleece", color: "heather grey" }),
    );
    expect(added.fabric).toBe("Heather grey fleece");
    ok(call("use_fabric_for_piece", { piece: "sleeves", fabric: "heather" }));
    const e = store.state.entities;
    const g = mainGarment(e)!;
    const sleeve = g.pieces.find((p) => p.name === "sleeve")!;
    for (const c of sleeve.cuts) {
      expect(cutFabric(e, g, c)?.stretch).toEqual(FLEECE.stretch);
      expect(cutColor(e, g, c)).toBe("#9a9c9e");
    }
    expect(cutFabric(e, g, g.pieces[0]!.cuts[0]!)?.category).toBe("knit");
    expect(accepted()).toBeNull();
    // Two edits, two undo steps.
    ok(call("undo"));
    ok(call("undo"));
    expect(store.state.entities.fabrics).toHaveLength(1);
  });

  it("scales a fabric value by a factor and reports before and after", () => {
    const { call, accepted } = setup();
    const r = ok(call("tune_fabric", { field: "bendingWarp", factor: 2 }));
    expect(r.after).toBeCloseTo((r.before as number) * 2);
    expect(accepted()).toBeNull();
  });

  it("answers bad requests with words, changing nothing", () => {
    const { store, call } = setup();
    const before = store.state.entities;
    for (const [name, args] of [
      ["set_fabric_kind", { kind: "chainmail" }],
      ["set_fabric_color", { color: "ultraviolet" }],
      ["use_fabric_for_piece", { piece: "collar", fabric: "x" }],
      ["tune_fabric", { field: "bendingWarp" }],
      ["tune_fabric", { field: "density", value: "heavy" }],
      ["redo", {}],
      ["no_such_tool", {}],
    ] as const) {
      const r = call(name, args);
      expect(r.ok, name).toBe(false);
    }
    expect(store.state.entities).toBe(before);
  });

  it("refuses everything while no design is open", () => {
    const store = new DocumentStore(engine, { freeze: true, drapeDelayMs: 5 });
    expect(callTool(store, "describe_design")).toEqual({
      ok: true,
      result: { open: false },
    });
    expect(callTool(store, "set_fabric_kind", { kind: "denim" }).ok).toBe(
      false,
    );
  });

  it("reads plain words for kinds and colours", () => {
    expect(findKind("hoodie fleece").name).toBe("Fleece");
    expect(findKind("Wool suiting").name).toBe("Wool suiting");
    expect(findColor("heather gray")).toBe("#9a9c9e");
    expect(findColor("#abc")).toBe("#aabbcc");
  });
});
