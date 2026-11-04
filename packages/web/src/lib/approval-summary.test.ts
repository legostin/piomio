import { describe, expect, it } from "vitest";
import { toolCall } from "./approval-summary";

describe("a tool call's card", () => {
  it("names the tool and lays out its input", () => {
    expect(toolCall('notion_update-page {"page_id":"40da","properties":{"Status":"In progress"}}')).toEqual({
      tool: "notion_update-page",
      input: '{\n  "page_id": "40da",\n  "properties": {\n    "Status": "In progress"\n  }\n}',
    });
  });

  it("keeps a cut input as it is and leaves summaries in words alone", () => {
    expect(toolCall('notion_update-page {"page_id":"40da","comm…')).toEqual({ tool: "notion_update-page", input: '{"page_id":"40da","comm…' });
    expect(toolCall("Run: ps aux")).toBeUndefined();
    expect(toolCall("Send an email to Ann")).toBeUndefined();
  });
});
