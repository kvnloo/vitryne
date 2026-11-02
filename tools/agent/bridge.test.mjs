#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// End-to-end test of hermes-bridge.mjs without a browser: starts the bridge, plays an editor tab
// (the event stream and the answers, as src/agent/bridge.ts does), and drives it over MCP stdio
// and over HTTP. `node tools/agent/bridge.test.mjs`; exits non-zero on the first failure.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PORT = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}/agent`;
const tools = JSON.parse(
  readFileSync(new URL("./tools.json", import.meta.url)),
);

const bridge = spawn(
  process.execPath,
  [
    new URL("./hermes-bridge.mjs", import.meta.url).pathname,
    "--port",
    String(PORT),
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let stderr = "";
bridge.stderr.on("data", (d) => (stderr += d));
const replies = new Map();
let out = "";
bridge.stdout.on("data", (d) => {
  out += d;
  let i;
  while ((i = out.indexOf("\n")) >= 0) {
    const msg = JSON.parse(out.slice(0, i));
    out = out.slice(i + 1);
    replies.get(msg.id)?.(msg);
  }
});
let next = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    replies.set(id, resolve);
    bridge.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake editor: answers every call the way the page would, with a tiny design. */
async function fakeEditor(origin) {
  const design = { color: "#f4f2ec", kind: "Cotton jersey" };
  const ctrl = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: origin ? { origin } : {},
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  await fetch(`${base}/hello`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({ tools, design: { open: true } }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!block.startsWith("event: call") || !data) continue;
        const call = JSON.parse(data.slice(6));
        let answer;
        if (call.tool === "set_fabric_color") {
          design.color = call.args.color;
          answer = {
            ok: true,
            result: { done: "Change a fabric's colour (assistant)" },
          };
        } else if (call.tool === "describe_design")
          answer = { ok: true, result: design };
        else answer = { ok: false, error: `no tool ${call.tool}` };
        await fetch(`${base}/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: call.id, ...answer }),
        });
      }
    }
  })();
  return { design, close: () => ctrl.abort() };
}

let failed = false;
try {
  for (let i = 0; i < 50 && !stderr.includes("listening"); i++) await sleep(50);

  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.serverInfo.name, "vitryne");
  const list = await rpc("tools/list", {});
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    tools.map((t) => t.name),
  );

  // No editor yet: a clear error, not a hang.
  const early = await rpc("tools/call", {
    name: "describe_design",
    arguments: {},
  });
  assert.equal(early.result.isError, true);
  assert.match(early.result.content[0].text, /\?agent=/);

  // A foreign web page may not connect.
  const evil = await fetch(`${base}/events`, {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(evil.status, 403);

  const editor = await fakeEditor("http://localhost:5173");
  await sleep(100);
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.editors, 1);

  const recolour = await rpc("tools/call", {
    name: "set_fabric_color",
    arguments: { color: "navy" },
  });
  assert.equal(recolour.result.isError, false);
  assert.equal(editor.design.color, "navy");

  const viaHttp = await (
    await fetch(`${base}/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "describe_design" }),
    })
  ).json();
  assert.deepEqual(viaHttp, {
    ok: true,
    result: { color: "navy", kind: "Cotton jersey" },
  });

  // A second bridge on the same port (another Hermes session) forwards to the first.
  const second = spawn(
    process.execPath,
    [
      new URL("./hermes-bridge.mjs", import.meta.url).pathname,
      "--port",
      String(PORT),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const secondReply = new Promise((resolve) => {
    let buf = "";
    second.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("\n"))
        resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
    });
  });
  await sleep(300);
  second.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_fabric_color", arguments: { color: "red" } } })}\n`,
  );
  const forwarded = await secondReply;
  second.kill();
  assert.equal(forwarded.result.isError, false);
  assert.equal(editor.design.color, "red");

  const unknown = await rpc("tools/call", { name: "explode", arguments: {} });
  assert.equal(unknown.result.isError, true);
  editor.close();
  console.log("bridge test: ok");
} catch (e) {
  failed = true;
  console.error("bridge test: FAILED\n", e, "\nbridge log:\n", stderr);
} finally {
  bridge.stdin.end();
  bridge.kill();
  process.exit(failed ? 1 : 0);
}
