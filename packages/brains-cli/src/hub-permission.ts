// Asking the hub whether a brain's own action may go ahead (core: tools/native-permission.ts), over the session's MCP
// endpoint. Any failure is a no: the action stays inside the sandbox.

/** The hub's answer: whether the action may go ahead, and what the agent should be told when it may not. */
export interface HubAnswer {
  allow: boolean;
  /** Why not (auto mode's reason, the person's no), for a brain whose own answer has no room for it. */
  message?: string;
}

/** Whether the hub (or the person, through it) allows `tool` with `input`. */
export async function askHub(mcp: { url: string; token: string }, permissionTool: string, tool: string, input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<HubAnswer> {
  try {
    const r = await fetchImpl(mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${mcp.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: permissionTool, arguments: { tool_name: tool, input } } }),
      // The person may take minutes to answer.
      signal: AbortSignal.timeout(16 * 60_000),
    });
    const j = (await r.json()) as { result?: { content?: Array<{ type: string; text?: string }> } };
    const text = j.result?.content?.find((c) => c.type === "text")?.text ?? "";
    const a = JSON.parse(text) as { behavior?: string; message?: unknown };
    if (a.behavior === "allow") return { allow: true };
    return { allow: false, ...(typeof a.message === "string" && a.message ? { message: a.message } : {}) };
  } catch {
    return { allow: false };
  }
}
