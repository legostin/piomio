import type { ToolCallContext, ToolDescriptor, ToolEffect, ToolResult } from "@piomio/shared";

export type ToolInvoker = (input: any, ctx: ToolCallContext) => Promise<ToolResult>;

/** The approval card's text, made by the core from the call's real input (core tools only). */
export type ToolDescriber = (input: any) => string;

/**
 * What this very call does, when it differs from the tool's effect (core tools only): machine_exec of a command that
 * only reads is a read. Undefined keeps the tool's own.
 */
export type ToolEffectOf = (input: any) => ToolEffect | undefined;

interface Entry {
  descriptor: ToolDescriptor;
  invoke: ToolInvoker;
  describe?: ToolDescriber;
  effectOf?: ToolEffectOf;
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeToolName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export class ToolRegistry {
  private tools = new Map<string, Entry>();
  onChange?: () => void;

  register(descriptor: ToolDescriptor, invoke: ToolInvoker, describe?: ToolDescriber, effectOf?: ToolEffectOf): void {
    if (!NAME_RE.test(descriptor.name)) throw new Error(`invalid tool name "${descriptor.name}" (allowed: a-z A-Z 0-9 _ -, up to 64)`);
    const existing = this.tools.get(descriptor.name);
    if (existing && existing.descriptor.owner !== descriptor.owner) {
      throw new Error(`tool ${descriptor.name} already registered by ${existing.descriptor.owner}`);
    }
    this.tools.set(descriptor.name, { descriptor, invoke, ...(describe ? { describe } : {}), ...(effectOf ? { effectOf } : {}) });
    this.onChange?.();
  }

  /** Take back one tool, only if `owner` registered it. */
  unregister(name: string, owner: string): void {
    if (this.tools.get(name)?.descriptor.owner !== owner) return;
    this.tools.delete(name);
    this.onChange?.();
  }

  unregisterOwner(owner: string): void {
    let changed = false;
    for (const [name, e] of this.tools) {
      if (e.descriptor.owner === owner) {
        this.tools.delete(name);
        changed = true;
      }
    }
    if (changed) this.onChange?.();
  }

  get(name: string): Entry | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((e) => e.descriptor).sort((a, b) => a.name.localeCompare(b.name));
  }
}
