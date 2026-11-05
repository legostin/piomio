import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultComposer } from "./Composer";

const data = vi.hoisted(() => {
  globalThis.sessionStorage = { getItem: () => JSON.stringify({ c: "clarification" }), setItem() {} } as unknown as Storage;
  return { running: true, group: false };
});
vi.mock("../../lib/native", () => ({ native: null, nativeErrorText: String }));
vi.mock("../../lib/mobile", () => ({ mobileMode: false }));
vi.mock("../../state/app", async () => {
  const { createStore } = await import("../../lib/store");
  return {
    agents: createStore([]), conversations: {}, groups: {},
    useSelector: (_store: unknown, select: (rows: unknown[]) => unknown) => select(data.group ? [{ id: "c", conversationId: "c", kind: "group", running: data.running }] : []),
    useConversationMessages: () => ({ messages: data.running && !data.group ? [{ status: "streaming" }] : [] }),
    ensureAgents() {}, warmConversation() {}, interrupt: vi.fn(), sendMessage: vi.fn(),
  };
});
vi.mock("../../state/attachments", () => ({ addFiles() {}, removeFiles() {}, usePendingFiles: () => [] }));
vi.mock("../../plugins/slots", () => ({ ComposerActions: () => null, usePluginRegistry: () => ({ contributions: [] }) }));
vi.mock("./AttachmentChips", () => ({ AttachmentChips: () => null }));
vi.mock("./AgentAvatar", () => ({ AgentAvatar: () => null }));

const render = () => renderToStaticMarkup(createElement(DefaultComposer, { conversationId: "c" }));
beforeEach(() => { data.running = true; data.group = false; });

describe("send while working", () => {
  it.each([false, true])("keeps an enabled Send beside a separate Stop (group %s)", (group) => {
    data.group = group;
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-label="Send"[^>]*>/);
    expect(html.match(/<button[^>]*aria-label="Send"[^>]*>/)?.[0]).not.toContain("disabled");
    expect(html).toMatch(/<button[^>]*aria-label="Stop"[^>]*>/);
    expect(html).toContain("clarification");
  });
  it("only removes Stop when the agent is idle", () => {
    data.running = false;
    expect(render()).toContain('aria-label="Send"');
    expect(render()).not.toContain('aria-label="Stop"');
  });
});
