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
    for (const word of ["new.example", "443", "Developer", "Check a new host", "10 minutes", "current session", "External actions", "Allow once", "Always allow", "Deny"]) expect(html).toContain(word);
    expect(html.match(/<button/g)).toHaveLength(3);
  });
  it("a listed host after outside content says why it asks and offers no always", () => {
    const html = render({ ...part, ask: { ...part.ask!, host: "github.com", listed: true } });
    expect(html).toContain("outside content");
    expect(html).not.toContain("Always allow");
    expect(html.match(/<button/g)).toHaveLength(2);
  });
  it("warns for a raw IP and removes buttons after the request expires", () => {
    const ip = { ...part, ask: { ...part.ask!, host: "1.1.1.1", ipLiteral: true } };
    expect(render(ip)).toContain("Its owner may change");
    const expired = render({ ...ip, status: "expired" });
    expect(expired).toContain("expired"); expect(expired).not.toMatch(/<button[^>]*>Allow once<\/button>/); expect(expired).toContain("Request again");
  });
  it("shows the actual deadline and hides permission buttons when it passes even without a live update", () => {
    const html = render({ ...part, ask: { ...part.ask!, networkExpiresAt: new Date(Date.now() + 600_000).toISOString() } });
    expect(html).toContain('role="timer"'); expect(html).toContain("10 min 0 sec");
    const overdue = render({ ...part, ask: { ...part.ask!, networkExpiresAt: new Date(Date.now() - 1).toISOString() } });
    expect(overdue).not.toMatch(/<button[^>]*>Allow once<\/button>/); expect(overdue).toContain("Request again");
  });
  it("explains a disconnected client and never offers late permission", () => {
    const html = render({ ...part, status: "expired", ask: { ...part.ask!, networkClosedReason: "connection_closed" } });
    expect(html).toContain("connection closed"); expect(html).not.toMatch(/<button[^>]*>Allow once<\/button>/);
    expect(html).toContain("does not approve access");
    expect(render({ ...part, status: "expired", ask: { ...part.ask!, networkRetryRequestedAt: new Date().toISOString() } })).not.toContain("<button");
  });
});
