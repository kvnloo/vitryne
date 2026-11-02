#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The assistant bridge: lets Hermes (or any MCP client) edit the design open in Vitryne.
//
//   node tools/agent/hermes-bridge.mjs [--port 7341] [--origin https://my.host] [--http-only]
//
// Then open the editor with `?agent=7341`. The page connects here (127.0.0.1 only) and runs each
// tool call through its own command system (packages/vitryne-web/src/agent/tools.ts), so every
// assistant edit is validated, re-draped and undoable like the person's own.
//
// Two ways in:
// - MCP over stdio (the default): `tools/list` from tools.json, `tools/call` forwarded to the page.
// - HTTP: POST /agent/call {"tool": "...", "args": {...}} answers {ok, result | error}.
// No dependencies: Node's http module, server-sent events to the page, JSON-RPC lines on stdio.

import { readFileSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const PORT = Number(opt("port", process.env.VITRYNE_AGENT_PORT ?? 7341));
const EXTRA_ORIGINS = argv.flatMap((a, i) =>
  argv[i - 1] === "--origin" ? [a] : [],
);
const HTTP_ONLY = argv.includes("--http-only");
const CALL_TIMEOUT_MS = 20_000;
const TOOLS = JSON.parse(
  readFileSync(new URL("./tools.json", import.meta.url), "utf8"),
);

const log = (...a) => console.error("[vitryne-bridge]", ...a);

// ---- the page --------------------------------------------------------------------------------

/** Open event streams from editor tabs; calls go to the newest. */
const pages = [];
/** Calls waiting for the page's answer, by id. */
const waiting = new Map();
let design = null;

function allowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return true;
  } catch {
    return false;
  }
  return origin === "https://vitryne.app" || EXTRA_ORIGINS.includes(origin);
}

/** Another bridge already holds the port (a second Hermes session): calls go through it. */
let forward = false;

async function callPage(tool, args) {
  if (forward) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/agent/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args }),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: `the bridge on port ${PORT} is gone: ${e}` };
    }
  }
  const page = pages.at(-1);
  if (!page)
    return Promise.resolve({
      ok: false,
      error: `no editor is connected: open Vitryne with ?agent=${PORT} (the bridge listens on 127.0.0.1:${PORT})`,
    });
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: "the editor did not answer in time" });
    }, CALL_TIMEOUT_MS);
    waiting.set(id, ({ id: _id, ...answer }) => {
      clearTimeout(timer);
      resolve(answer);
    });
    page.write(
      `event: call\ndata: ${JSON.stringify({ id, tool, args: args ?? {} })}\n\n`,
    );
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!allowedOrigin(origin)) {
    res.writeHead(403).end("origin not allowed");
    return;
  }
  const cors = origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
        "cross-origin-resource-policy": "cross-origin",
        vary: "origin",
      }
    : {};
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const json = (code, v) =>
    res
      .writeHead(code, { ...cors, "content-type": "application/json" })
      .end(JSON.stringify(v));
  try {
    if (req.method === "GET" && req.url === "/agent/events") {
      res.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      pages.push(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      log(`editor connected (${pages.length} open)`);
      req.on("close", () => {
        clearInterval(ping);
        pages.splice(pages.indexOf(res), 1);
        log(`editor left (${pages.length} open)`);
      });
      return;
    }
    if (req.method === "POST" && req.url === "/agent/hello") {
      const b = await readJson(req);
      design = b.design ?? null;
      const names = (b.tools ?? []).map((t) => t.name).join(",");
      const known = TOOLS.map((t) => t.name).join(",");
      if (names !== known)
        log(
          `warning: the page's tools (${names}) differ from tools.json (${known})`,
        );
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === "/agent/result") {
      const b = await readJson(req);
      waiting.get(b.id)?.(b);
      waiting.delete(b.id);
      json(200, { ok: true });
      return;
    }
    if (req.method === "POST" && req.url === "/agent/call") {
      const b = await readJson(req);
      json(200, await callPage(b.tool, b.args));
      return;
    }
    if (req.method === "GET" && req.url === "/agent/status") {
      json(200, {
        editors: pages.length,
        design,
        tools: TOOLS.map((t) => t.name),
      });
      return;
    }
    json(404, { ok: false, error: "not found" });
  } catch (e) {
    json(400, { ok: false, error: String(e) });
  }
});

server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  forward = true;
  log(`port ${PORT} is taken by another bridge: forwarding calls to it`);
});
server.listen(PORT, "127.0.0.1", () =>
  log(
    `listening on http://127.0.0.1:${PORT}; open the editor with ?agent=${PORT}`,
  ),
);

// ---- MCP over stdio ----------------------------------------------------------------------------

if (!HTTP_ONLY) {
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) return; // a notification
    const reply = (result) => send({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        reply({
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "vitryne", version: "0.1.0" },
          instructions:
            "Edits the garment open in the Vitryne editor. Call describe_design first. Every edit is one undo step the designer can take back.",
        });
        return;
      case "ping":
        reply({});
        return;
      case "tools/list":
        reply({ tools: TOOLS });
        return;
      case "tools/call": {
        const answer = await callPage(params?.name, params?.arguments);
        reply({
          content: [
            {
              type: "text",
              text: answer.ok
                ? JSON.stringify(answer.result, null, 1)
                : answer.error,
            },
          ],
          isError: !answer.ok,
        });
        return;
      }
      default:
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `no method ${method}` },
        });
    }
  });
  rl.on("close", () => {
    server.close();
    process.exit(0);
  });
}
