// A machine's connections to the hub's other replicas: one to each address the hub lists (node.setup `hubs`), so
// whichever replica leads finds this machine at once. The list changes: a replica's link comes up after it started,
// a replica is removed. An address that left the list is dropped unless its connection works, or the machine would
// knock at it every minute for as long as it runs.

export interface HubLink {
  state: string;
  start(): void;
  stop(): Promise<void> | void;
}

const norm = (u: string) => u.replace(/\/+$/, "");

export class HubLinks<C extends HubLink> {
  private main: string;
  private make: (url: string) => C;
  private others = new Map<string, C>();

  /** `main`: the hub this machine paired with, which has a connection of its own. */
  constructor(main: string, make: (url: string) => C) {
    this.main = norm(main);
    this.make = make;
  }

  /** The replicas' addresses as the hub lists them now. No list (an older hub, a hub of one) changes nothing. */
  set(urls: string[]): void {
    if (!urls.length) return;
    const listed = new Set(urls.map(norm));
    for (const [u, c] of this.others) {
      if (listed.has(u) || c.state === "online") continue;
      this.others.delete(u);
      void c.stop();
    }
    for (const u of listed) {
      if (u === this.main || this.others.has(u)) continue;
      const c = this.make(u);
      this.others.set(u, c);
      c.start();
    }
  }

  urls(): string[] {
    return [...this.others.keys()];
  }

  async stop(): Promise<void> {
    const all = [...this.others.values()];
    this.others.clear();
    await Promise.all(all.map((c) => c.stop()));
  }
}
