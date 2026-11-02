// SPDX-License-Identifier: AGPL-3.0-or-later
// Lets an assistant edit the open design through the bridge (src/agent/bridge.ts) when the editor
// was opened with `?agent=<port>`, and gives scripts in the page (CDP, the console) the same tools
// as `window.vitryneAgent`. Returns the bridge's status for the top bar, or null when it is off.

import { useEffect, useState } from "react";
import { agentPort, type BridgeStatus, connectBridge } from "@/agent/bridge";
import { type AgentStore, callTool, toolList } from "@/agent/tools";

declare global {
  interface Window {
    vitryneAgent?: {
      tools: ReturnType<typeof toolList>;
      call: (name: string, args?: Record<string, unknown>) => unknown;
    };
  }
}

export function useAgentBridge(store: AgentStore): BridgeStatus | null {
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  useEffect(() => {
    window.vitryneAgent = {
      tools: toolList(),
      call: (name, args) => callTool(store, name, args),
    };
    const port = agentPort();
    if (port === null) return () => delete window.vitryneAgent;
    const stop = connectBridge(store, port, setStatus);
    return () => {
      stop();
      delete window.vitryneAgent;
    };
  }, [store]);

  return status;
}
