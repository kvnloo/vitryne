// SPDX-License-Identifier: AGPL-3.0-or-later
// The page's end of the assistant bridge (tools/agent/hermes-bridge.mjs). Off unless the person
// opens the editor with `?agent=<port>`; then it listens to the bridge on 127.0.0.1 only for tool
// calls (server-sent events) and posts each answer back. No other host is ever contacted, and
// nothing is sent unless the bridge asks (CLAUDE.md, rule 7: network calls only for what the
// person does; starting the bridge and opening this URL is that).

import { type AgentStore, callTool, describe, toolList } from "./tools";

const KEY = "vitryne.agentPort";

/** The bridge's port from `?agent=`, remembered for the tab; null when the bridge is off. */
export function agentPort(loc: Location = location): number | null {
  const fromUrl = new URLSearchParams(loc.search).get("agent");
  if (fromUrl !== null) {
    if (fromUrl === "off" || fromUrl === "0") {
      sessionStorage.removeItem(KEY);
      return null;
    }
    sessionStorage.setItem(KEY, fromUrl);
  }
  const port = Number(sessionStorage.getItem(KEY));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export interface BridgeStatus {
  port: number;
  connected: boolean;
  calls: number;
  last: string | null;
}

interface Call {
  id: string;
  tool: string;
  args?: Record<string, unknown>;
}

/** Connects to the bridge; returns a function that disconnects. */
export function connectBridge(
  store: AgentStore,
  port: number,
  onStatus: (s: BridgeStatus) => void,
): () => void {
  const base = `http://127.0.0.1:${port}/agent`;
  const status: BridgeStatus = { port, connected: false, calls: 0, last: null };
  const post = (path: string, body: unknown) =>
    fetch(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});

  const events = new EventSource(`${base}/events`);
  events.onopen = () => {
    status.connected = true;
    onStatus({ ...status });
    void post("hello", { tools: toolList(), design: describe(store.state) });
  };
  events.onerror = () => {
    status.connected = false;
    onStatus({ ...status });
  };
  events.addEventListener("call", (ev) => {
    let call: Call;
    try {
      call = JSON.parse((ev as MessageEvent<string>).data) as Call;
    } catch {
      return;
    }
    let answer;
    try {
      answer = callTool(store, call.tool, call.args ?? {});
    } catch (e) {
      answer = { ok: false as const, error: `failed: ${(e as Error).message}` };
    }
    status.calls++;
    status.last = call.tool;
    onStatus({ ...status });
    void post("result", { id: call.id, ...answer });
  });
  return () => events.close();
}
