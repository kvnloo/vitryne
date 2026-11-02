// SPDX-License-Identifier: AGPL-3.0-or-later
// What an assistant (Hermes, or any MCP client through tools/agent/hermes-bridge.mjs) may do to
// the open design, as named tools with JSON arguments. Every tool reads the document or runs one
// of `document/commands.ts`'s builders through the store, so an assistant's edit is checked,
// validated by Rust, re-draped and undone exactly like the person's own (one undo step each,
// labelled "(assistant)"). Nothing here touches sewing, placement, measuring or grading
// (packages/vitryne-docs/content/docs/developers/patents.md): the assistant changes fabrics,
// colours and names, and undoes; the person sews and places.

import {
  addFabric,
  applyFabricPreset,
  type Command,
  cutColor,
  cutFabric,
  FABRIC_FIELDS,
  type FabricField,
  fabricColor,
  fabricUse,
  fabricValue,
  renameProject,
  setDefaultFabric,
  setFabricColor,
  setFabricValue,
  setPieceFabric,
} from "@/document/commands";
import { type Entities, mainGarment } from "@/document/entities";
import type { DocState } from "@/document/store";
import { COLOR_SWATCHES, normalizeColor } from "@/format/colors";
import { FABRIC_PRESETS, matchingPreset } from "@/format/presets";
import type { Fabric, Garment } from "@/format/schema.gen";

/** The part of `DocumentStore` the tools use (a fake in tests). */
export interface AgentStore {
  readonly state: DocState;
  execute(build: (e: Entities) => Command): boolean;
  undo(): void;
  redo(): void;
}

/** A JSON Schema for a tool's arguments (the subset MCP clients read). */
export interface ParamSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

export interface AgentTool {
  name: string;
  description: string;
  params: ParamSchema;
  run(store: AgentStore, args: Record<string, unknown>): unknown;
}

/** A tool that can't do what was asked: the message says why, in words for the assistant. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

const SUFFIX = " (assistant)";

/** Plain words for the five fabric kinds, as people say them. */
const KIND_WORDS: Record<string, string> = {
  jersey: "Cotton jersey",
  "cotton jersey": "Cotton jersey",
  "t-shirt": "Cotton jersey",
  tee: "Cotton jersey",
  knit: "Cotton jersey",
  denim: "Denim",
  jeans: "Denim",
  poplin: "Poplin (shirting)",
  shirting: "Poplin (shirting)",
  fleece: "Fleece",
  sweatshirt: "Fleece",
  hoodie: "Fleece",
  wool: "Wool suiting",
  suiting: "Wool suiting",
};

function words(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Whether a name answers to what was asked: the same words, a part of them, or a plural. */
function answers(name: string, asked: string): boolean {
  const n = words(name);
  const a = words(asked);
  const one = a.endsWith("s") ? a.slice(0, -1) : a;
  return (
    n === a || n === one || n.includes(a) || (one.length > 2 && n.includes(one))
  );
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new AgentError(`${key} must be a string`);
  return v;
}

function need(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new AgentError(`${key} is required`);
  return v;
}

function num(args: Record<string, unknown>, key: string) {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new AgentError(`${key} must be a number`);
  return v;
}

function openGarment(store: AgentStore): Garment {
  if (store.state.empty) throw new AgentError("no design is open");
  const g = mainGarment(store.state.entities);
  if (!g) throw new AgentError("the design has no garment yet");
  return g;
}

/** A fabric kind from its preset name or a plain word ("denim", "hoodie fleece"). */
export function findKind(name: string): Fabric {
  const w = words(name);
  const exact = FABRIC_PRESETS.find((p) => words(p.name) === w);
  if (exact) return exact;
  for (const [word, preset] of Object.entries(KIND_WORDS)) {
    if (w !== word && !w.split(" ").includes(word)) continue;
    const kind = FABRIC_PRESETS.find((p) => p.name === preset);
    if (kind) return kind;
  }
  throw new AgentError(
    `no fabric kind "${name}"; kinds: ${FABRIC_PRESETS.map((p) => p.name).join(", ")}`,
  );
}

/** `#rrggbb`, `#rgb` or a swatch name ("navy", "heather grey"). */
export function findColor(name: string): string {
  let w = words(name);
  if (/^#[0-9a-f]{3}$/.test(w))
    w = `#${w[1]}${w[1]}${w[2]}${w[2]}${w[3]}${w[3]}`;
  const hex = normalizeColor(w);
  if (hex) return hex;
  const swatch =
    COLOR_SWATCHES.find((s) => words(s.name) === w) ??
    COLOR_SWATCHES.find((s) => words(s.name).replace("grey", "gray") === w);
  if (swatch) return swatch.color;
  throw new AgentError(
    `"${name}" is not a colour: give #rrggbb or one of ${COLOR_SWATCHES.map((s) => s.name.toLowerCase()).join(", ")}`,
  );
}

/** A fabric of the document by id or name (whole, then part); none: the garment's own. */
function findFabric(store: AgentStore, ref: string | undefined): Fabric {
  const e = store.state.entities;
  if (ref === undefined) {
    const g = openGarment(store);
    const f = e.fabrics.find((x) => x.id === g.fabric);
    if (!f) throw new AgentError("the garment has no fabric");
    return f;
  }
  const w = words(ref);
  const f =
    e.fabrics.find((x) => x.id === ref) ??
    e.fabrics.find((x) => words(x.name) === w) ??
    e.fabrics.find((x) => answers(x.name, ref));
  if (!f)
    throw new AgentError(
      `no fabric "${ref}"; fabrics: ${e.fabrics.map((x) => x.name).join(", ")}`,
    );
  return f;
}

function findPiece(g: Garment, ref: string) {
  const w = words(ref);
  const p =
    g.pieces.find((x) => x.id === ref) ??
    g.pieces.find((x) => words(x.name) === w) ??
    g.pieces.find((x) => answers(x.name, ref));
  if (!p)
    throw new AgentError(
      `no piece "${ref}"; pieces: ${g.pieces.map((x) => x.name).join(", ")}`,
    );
  return p;
}

/** Runs one edit as an undo step of its own, or says why it was refused. */
function edit(store: AgentStore, build: (e: Entities) => Command): string {
  let label = "";
  const ok = store.execute((e) => {
    const cmd = build(e);
    label = cmd.label + SUFFIX;
    return { ...cmd, label };
  });
  if (!ok) {
    const why = store.state.refused;
    throw new AgentError(why ?? "nothing changes");
  }
  return label;
}

/** The design as an assistant needs it: names, fabrics, colours; no geometry. */
export function describe(state: DocState) {
  if (state.empty) return { open: false };
  const e = state.entities;
  const g = mainGarment(e);
  const fabrics = e.fabrics.map((f) => ({
    id: f.id,
    name: f.name,
    kind: matchingPreset(f)?.name ?? "custom",
    category: f.category,
    color: fabricColor(e, f) ?? null,
    pieces: fabricUse(e, f.id).cuts,
    garmentDefault: fabricUse(e, f.id).garmentDefault,
  }));
  return {
    open: true,
    project: e.project?.name ?? null,
    garment: g
      ? {
          name: g.name,
          fabric: e.fabrics.find((f) => f.id === g.fabric)?.name ?? null,
          pieces: g.pieces.map((p) => ({
            name: p.name,
            cuts: p.cuts.map((c) => ({
              name: c.name ?? p.name,
              fabric: cutFabric(e, g, c)?.name ?? null,
              color: cutColor(e, g, c) ?? null,
              state: c.state ?? "placed",
            })),
          })),
          seams: g.seams.length,
        }
      : null,
    fabrics,
    undo: state.undoLabel,
    redo: state.redoLabel,
    warnings: state.warnings,
    kinds: FABRIC_PRESETS.map((p) => p.name),
    colors: COLOR_SWATCHES.map((s) => `${s.name} ${s.color}`),
  };
}

const FABRIC_REF = {
  type: "string",
  description:
    "Fabric id or name (as describe_design lists them); leave out for the garment's main fabric",
};

export const AGENT_TOOLS: readonly AgentTool[] = [
  {
    name: "describe_design",
    description:
      "What is open: the garment, its pieces with their fabric and colour, the fabrics, the undo/redo labels, and the fabric kinds and colour swatches the other tools accept. Call first.",
    params: { type: "object", properties: {} },
    run: (store) => describe(store.state),
  },
  {
    name: "set_fabric_kind",
    description:
      "Make a fabric hang like another kind of cloth (jersey, denim, poplin, fleece, wool suiting). The 3D garment re-drapes.",
    params: {
      type: "object",
      properties: {
        kind: { type: "string", description: "e.g. denim, fleece, jersey" },
        fabric: FABRIC_REF,
      },
      required: ["kind"],
    },
    run: (store, a) => {
      const f = findFabric(store, str(a, "fabric"));
      const preset = findKind(need(a, "kind"));
      return { done: edit(store, (e) => applyFabricPreset(e, f.id, preset)) };
    },
  },
  {
    name: "set_fabric_color",
    description:
      "Recolour a fabric (every piece cut from it). Accepts #rrggbb or a swatch name like navy or heather grey.",
    params: {
      type: "object",
      properties: {
        color: { type: "string", description: "#rrggbb or a swatch name" },
        fabric: FABRIC_REF,
      },
      required: ["color"],
    },
    run: (store, a) => {
      const f = findFabric(store, str(a, "fabric"));
      const color = findColor(need(a, "color"));
      return { done: edit(store, (e) => setFabricColor(e, f.id, color)) };
    },
  },
  {
    name: "tune_fabric",
    description: `Change one physical value of a fabric, either to a value or by a factor (factor 2 = twice as stiff/stretchy-resistant/heavy). Fields: ${Object.keys(FABRIC_FIELDS).join(", ")}. Density is kg/m², bending is stiffness, stretch is resistance to stretching.`,
    params: {
      type: "object",
      properties: {
        field: { type: "string", enum: Object.keys(FABRIC_FIELDS) },
        value: { type: "number" },
        factor: { type: "number", description: "multiply the current value" },
        fabric: FABRIC_REF,
      },
      required: ["field"],
    },
    run: (store, a) => {
      const f = findFabric(store, str(a, "fabric"));
      const field = need(a, "field") as FabricField;
      if (!(field in FABRIC_FIELDS))
        throw new AgentError(
          `no field ${field}; fields: ${Object.keys(FABRIC_FIELDS).join(", ")}`,
        );
      const value = num(a, "value");
      const factor = num(a, "factor");
      const before = fabricValue(f, field);
      let after: number;
      if (value !== undefined && factor === undefined) after = value;
      else if (factor !== undefined && value === undefined)
        after = before * factor;
      else throw new AgentError("give either value or factor");
      const done = edit(store, (e) => setFabricValue(e, f.id, field, after));
      return { done, field, before, after };
    },
  },
  {
    name: "add_fabric",
    description:
      "Add a new fabric of a kind and colour (for a contrast piece). Nothing uses it until use_fabric_for_piece or set_garment_fabric.",
    params: {
      type: "object",
      properties: {
        kind: { type: "string" },
        color: { type: "string" },
        name: {
          type: "string",
          description: "optional; default from colour and kind",
        },
      },
      required: ["kind", "color"],
    },
    run: (store, a) => {
      openGarment(store);
      const preset = findKind(need(a, "kind"));
      const color = findColor(need(a, "color"));
      const name = str(a, "name");
      const before = new Set(store.state.entities.fabrics.map((f) => f.id));
      const done = edit(store, (e) => addFabric(e, { preset, color, name }));
      const added = store.state.entities.fabrics.find((f) => !before.has(f.id));
      return { done, fabric: added?.name, id: added?.id };
    },
  },
  {
    name: "use_fabric_for_piece",
    description:
      "Cut a piece (every copy of it, e.g. both sleeves) from a fabric. Leave fabric out to go back to the garment's main fabric.",
    params: {
      type: "object",
      properties: {
        piece: { type: "string", description: "piece name, e.g. sleeve" },
        fabric: { type: "string", description: "fabric id or name" },
      },
      required: ["piece"],
    },
    run: (store, a) => {
      const g = openGarment(store);
      const piece = findPiece(g, need(a, "piece"));
      const ref = str(a, "fabric");
      const fabricId =
        ref === undefined ? undefined : findFabric(store, ref).id;
      return {
        done: edit(store, (e) => setPieceFabric(e, g.id, piece.id, fabricId)),
        piece: piece.name,
      };
    },
  },
  {
    name: "set_garment_fabric",
    description:
      "Make a fabric the garment's main one (every piece without its own fabric).",
    params: {
      type: "object",
      properties: { fabric: { type: "string" } },
      required: ["fabric"],
    },
    run: (store, a) => {
      const g = openGarment(store);
      const f = findFabric(store, need(a, "fabric"));
      return { done: edit(store, (e) => setDefaultFabric(e, g.id, f.id)) };
    },
  },
  {
    name: "rename_project",
    description: "Rename the project.",
    params: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    run: (store, a) => ({
      done: edit(store, (e) => renameProject(e, need(a, "name"))),
    }),
  },
  {
    name: "undo",
    description:
      "Undo the last edit (the person's or the assistant's), as the Undo button does.",
    params: { type: "object", properties: {} },
    run: (store) => {
      const label = store.state.undoLabel;
      if (label === null) throw new AgentError("nothing to undo");
      store.undo();
      return { undone: label };
    },
  },
  {
    name: "redo",
    description: "Redo the last undone edit.",
    params: { type: "object", properties: {} },
    run: (store) => {
      const label = store.state.redoLabel;
      if (label === null) throw new AgentError("nothing to redo");
      store.redo();
      return { redone: label };
    },
  },
];

export type ToolResult =
  { ok: true; result: unknown } | { ok: false; error: string };

/** Runs a tool by name; an `AgentError` (or a refused edit) is an answer, not a crash. */
export function callTool(
  store: AgentStore,
  name: string,
  args: Record<string, unknown> = {},
): ToolResult {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `no tool ${name}` };
  try {
    return { ok: true, result: tool.run(store, args) };
  } catch (e) {
    if (e instanceof AgentError) return { ok: false, error: e.message };
    throw e;
  }
}

/** The tools as MCP lists them. */
export function toolList() {
  return AGENT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.params,
  }));
}
