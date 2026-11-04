// What a card says for a tool call the hub describes only as "<tool> <JSON input>" (gateway.ts summarize, a tool with
// neither describe nor approvalSummary, such as an MCP server's): the tool's name for the headline, the input below.

/** The tool and its input (pretty when it is whole JSON), or undefined for a summary in words. */
export function toolCall(summary: string): { tool: string; input: string } | undefined {
  const m = /^([a-zA-Z0-9_-]{1,64}) ([[{][\s\S]*)$/.exec(summary.trim());
  if (!m) return undefined;
  let input = m[2];
  try {
    input = JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    // Cut at 300 characters by the hub: shown as it is.
  }
  return { tool: m[1], input };
}
