// One-time sign-in tickets of the desktop app and the commands it sends over the hub's stdin.
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { DesktopTickets, readDesktopCommands } from "../src/desktop-login.ts";

const ticket = "a".repeat(43);

describe("desktop sign-in tickets", () => {
  it("lets a ticket in once", () => {
    const tickets = new DesktopTickets();
    tickets.add(ticket);
    expect(tickets.consume(ticket)).toBe(true);
    expect(tickets.consume(ticket)).toBe(false);
  });

  it("forgets a ticket after a minute and ignores malformed ones", () => {
    let now = 1_000;
    const tickets = new DesktopTickets(() => now);
    tickets.add(ticket);
    now += 60_001;
    expect(tickets.consume(ticket)).toBe(false);
    tickets.add("short");
    expect(tickets.consume("short")).toBe(false);
  });

  it("reads the app's lines and stops when the pipe closes", async () => {
    const input = new PassThrough();
    const seen: string[] = [];
    readDesktopCommands(input, { stop: () => seen.push("stop"), ticket: (t) => seen.push(`ticket ${t}`), updateFailed: (why) => seen.push(`failed: ${why}`) });
    input.write(`ticket ${ticket}\nnoise\nupdate-failed error sending request for url (https://github.com/…)\nstop\n`);
    input.end();
    await vi.waitFor(() => expect(seen).toEqual([`ticket ${ticket}`, "failed: error sending request for url (https://github.com/…)", "stop", "stop"]));
  });
});
