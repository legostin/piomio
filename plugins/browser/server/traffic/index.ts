// The browser's traffic for agents: the log of what tabs ask and get, the rules that change it, and the secrets hidden
// from both. Off until the person turns the «Browser traffic» ability on in the catalog (plugins/browser-traffic).

import { TrafficLog } from "./log.ts";
import { Secrets } from "./redact.ts";
import { TrafficRules } from "./rules.ts";

export class Traffic {
  readonly secrets = new Secrets();
  readonly log: TrafficLog;
  readonly rules: TrafficRules;

  /** `changed`: the rules changed (the live view shows who changes a tab's traffic). */
  constructor(changed: () => void) {
    this.log = new TrafficLog(this.secrets);
    this.rules = new TrafficRules(this.log, changed);
  }

  get on(): boolean {
    return this.log.on;
  }

  /** Turned off: nothing more is kept, what was kept is dropped, and every rule is taken away. */
  async setOn(on: boolean): Promise<void> {
    if (on === this.log.on) return;
    this.log.on = on;
    if (on) return;
    this.log.clear();
    await this.rules.remove(undefined);
  }
}
