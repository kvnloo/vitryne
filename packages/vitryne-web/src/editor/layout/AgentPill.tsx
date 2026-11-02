// SPDX-License-Identifier: AGPL-3.0-or-later
// Shows that an assistant is connected (src/agent/bridge.ts) and what it last did, so an edit
// the person didn't make is never a mystery. Nothing shows while the bridge is off.

import { Bot } from "lucide-react";
import type { BridgeStatus } from "@/agent/bridge";
import { cn } from "@/lib/utils";

export function AgentPill({ status }: { status: BridgeStatus | null }) {
  if (!status) return null;
  const text = status.connected
    ? status.last
      ? `Assistant: ${status.last.replaceAll("_", " ")}`
      : "Assistant connected"
    : "Assistant: waiting for the bridge";
  return (
    <div
      role="status"
      title={`Bridge on 127.0.0.1:${status.port}, ${status.calls} call${status.calls === 1 ? "" : "s"}`}
      className="bg-background/90 text-muted-foreground pointer-events-none fixed right-3 bottom-3 z-40 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs shadow-sm"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status.connected ? "bg-live" : "bg-line",
        )}
      />
      <Bot className="size-3.5" aria-hidden />
      {text}
    </div>
  );
}
