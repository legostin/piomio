import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MessagePart } from "@piomio/shared";
import { NetworkApprovalCard } from "./NetworkApprovalCard";

const part: Extract<MessagePart, { type: "approval" }> = {
  type: "approval", approvalId: "a-test", status: "pending", summary: "Allow network",
  ask: { kind: "network", detail: "new.example:443", host: "new.example", port: 443, agent: "Developer", task: "Check a new host" },
};
const render = (p = part) => renderToStaticMarkup(createElement(NetworkApprovalCard, { part: p }));

describe("network permission card", () => {
  it("renders agent, task, exact destination, scope, timeout and three actions", () => {
    const html = render();
    for (const word of ["new.example", "443", "Developer", "Check a new host", "90 seconds", "current session", "External actions", "Allow once", "Always allow", "Deny"]) expect(html).toContain(word);
    expect(html.match(/<button/g)).toHaveLength(3);
  });
  it("warns for a raw IP and removes buttons after the request expires", () => {
    const ip = { ...part, ask: { ...part.ask!, host: "1.1.1.1", ipLiteral: true } };
    expect(render(ip)).toContain("Its owner may change");
    const expired = render({ ...ip, status: "expired" });
    expect(expired).toContain("expired"); expect(expired).not.toContain("<button");
  });
});
