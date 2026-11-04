// The person's side of a chapter: what the person in the story does in the app. The script types into the real composer, presses
// the real buttons and waits for the hub, so what the visitor sees is the app's own behaviour.

import type { Message } from "@piomio/shared";
import { agentPath } from "../../lib/team";
import { t } from "../../i18n";
import type { DemoHub } from "../hub/hub";
import { dialogOf, type AgentId } from "../world";
import type { Clock } from "./clock";
import type { Cursor } from "./cursor";
import { buttonByText, composer, setFieldValue, StepError, waitFor, type Finder } from "./dom";

export interface Navigator {
  path(): string;
  go(path: string): void;
}

export class Person {
  private hub: DemoHub;
  private clock: Clock;
  private cursor: Cursor;
  private nav: Navigator;

  constructor(hub: DemoHub, clock: Clock, cursor: Cursor, nav: Navigator) {
    this.hub = hub;
    this.clock = clock;
    this.cursor = cursor;
    this.nav = nav;
  }

  wait(ms: number): Promise<void> {
    return this.clock.wait(ms);
  }

  /** Opens an agent's dialog (as a tap on it in the team list would). */
  async open(agent: AgentId): Promise<void> {
    const path = agentPath(agent, this.hub.world.defaultAgent);
    if (this.nav.path() !== path) this.nav.go(path);
    await waitFor(this.clock, composer, "the composer");
    await this.clock.wait(350);
  }

  /** Types a message letter by letter into the composer and sends it with the send button; resolves with what the hub got. */
  async say(text: string, agent?: AgentId): Promise<Message> {
    if (agent) await this.open(agent);
    const field = await waitFor(this.clock, composer, "the composer");
    await this.cursor.moveTo(this.clock, field);
    field.focus({ preventScroll: true });
    let typed = "";
    for (const ch of text) {
      typed += ch;
      setFieldValue(field as HTMLTextAreaElement, typed);
      await this.clock.wait(ch === " " ? 55 : 28 + Math.random() * 38);
    }
    await this.clock.wait(260);
    const send = await waitFor(this.clock, () => document.querySelector<HTMLButtonElement>(`button[aria-label="${t("composer.send")}"]`), "the send button");
    const arrived = this.hub.nextUserMessage();
    await this.cursor.moveTo(this.clock, send);
    await this.cursor.press(this.clock);
    send.click();
    const m = await this.clock.until(arrived);
    field.blur();
    return m;
  }

  /** Points at an element and presses it. */
  async press(find: Finder, what: string): Promise<void> {
    const el = await waitFor(this.clock, find, what);
    await this.cursor.moveTo(this.clock, el);
    await this.clock.wait(220);
    await this.cursor.press(this.clock);
    if (el.isConnected && !(el as HTMLButtonElement).disabled) el.click();
  }

  /** Taps a quick reply under the agent's message; the hub turns it into the person's message. */
  async choose(option: string): Promise<Message> {
    const arrived = this.hub.nextUserMessage();
    await this.press(() => buttonByText(option), `the quick reply “${option}”`);
    return this.clock.until(arrived);
  }

  /**
   * Answers an approval card. The visitor may have pressed it already: then the script only waits for the answer.
   * Resolves with what was decided.
   */
  async decide(approvalId: string, decision: "approve" | "always" | "deny", pause = 1400): Promise<"approved" | "denied"> {
    const answered = this.hub.waitApproval(approvalId);
    const early = await Promise.race([answered.then(() => true), this.clock.wait(pause).then(() => false)]);
    if (!early) {
      const label = t(decision === "approve" ? "message.approval.approve" : decision === "always" ? "message.approval.always" : "message.approval.deny");
      await this.press(() => buttonByText(label), `the approval button “${label}”`);
    }
    return (await this.clock.until(answered)).status;
  }

  /** Types into a field of a card (a secret, a sign-in), letter by letter, as a person would. */
  async fill(find: () => HTMLInputElement | HTMLTextAreaElement | null | undefined, value: string, what: string): Promise<void> {
    const field = (await waitFor(this.clock, find, what)) as HTMLInputElement;
    await this.cursor.moveTo(this.clock, field);
    await this.cursor.press(this.clock);
    field.focus({ preventScroll: true });
    let typed = "";
    for (const ch of value) {
      typed += ch;
      setFieldValue(field, typed);
      await this.clock.wait(24 + Math.random() * 30);
    }
    await this.clock.wait(300);
  }

  /** Presses an element if it shows up soon; a window that has already gone needs no press. */
  async pressIfThere(find: Finder, what: string, timeoutMs = 1500): Promise<boolean> {
    try {
      await waitFor(this.clock, find, what, timeoutMs);
    } catch (e) {
      if (e instanceof StepError) return false;
      throw e;
    }
    await this.press(find, what);
    return true;
  }

  /** Presses the newest button that says `label`. */
  pressText(label: string): Promise<void> {
    return this.press(() => buttonByText(label), `the button “${label}”`);
  }

  /** Points at a spot on screen and presses there (on the live view's picture: the page underneath reacts). */
  async pointAt(at: { x: number; y: number } | undefined, what: string): Promise<void> {
    if (!at) throw new StepError(`nowhere to point: ${what}`);
    await this.cursor.moveTo(this.clock, at);
    await this.clock.wait(180);
    await this.cursor.press(this.clock);
  }

  /** The person's words while they show something, as the voice is written down. */
  async speak(text: string, ms = 2600): Promise<void> {
    this.cursor.caption(text, ms, this.clock);
    // The teach bar's mic ring follows the voice while the words are said.
    const mic = document.querySelector<HTMLElement>(".obb-mic");
    const end = Date.now() + (ms * 0.8) / this.clock.speed;
    const pulse = () => {
      if (!mic?.isConnected) return;
      if (Date.now() > end) return void mic.style.setProperty("--lvl", "0");
      mic.style.setProperty("--lvl", (0.25 + Math.random() * 0.65).toFixed(2));
      setTimeout(pulse, 90);
    };
    pulse();
    await this.clock.wait(ms * 0.6);
  }

  /** Highlight: the toggle in the live view, then a frame dragged over `box` on the picture. */
  async highlight(box: DOMRect): Promise<void> {
    await this.press(() => document.querySelector(".obb-hl-btn"), "the Highlight button");
    const layer = await waitFor(this.clock, () => document.querySelector(".obb-hl.is-on"), "the highlight layer");
    const pad = 6;
    const a = { x: box.left - pad, y: box.top - pad };
    const b = { x: box.right + pad, y: box.bottom + pad };
    const fire = (type: string, p: { x: number; y: number }) =>
      layer.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, pointerId: 7, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1 }));
    await this.cursor.moveTo(this.clock, a);
    fire("pointerdown", a);
    for (let i = 1; i <= 12; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 };
      await this.cursor.moveTo(this.clock, p);
      fire("pointermove", p);
    }
    fire("pointerup", b);
    this.cursor.rest();
  }

  /** Goes to a page of the app (a channel, Tasks). */
  async go(path: string): Promise<void> {
    this.nav.go(path);
    await this.clock.wait(500);
  }

  /** The dialog an agent's reply goes to. */
  dialog(agent: AgentId): string {
    return dialogOf(agent);
  }
}
