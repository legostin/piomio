// Plugin manifests: our .piomio-plugin/plugin.json plus Claude Code and Codex formats.

import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { LOCALES, type Catalog } from "./i18n.ts";

const relPath = z
  .string()
  .refine((p) => p.startsWith("./") && !p.split(/[\\/]/).includes(".."), "path must start with ./ and stay inside the plugin");

/** A page a person opens from a card: https only (a link may reach the system browser). */
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "link must be an https:// address");

export const PluginPermissionsSchema = z
  .object({
    /** Hostname patterns for egress, "*" = any. */
    network: z.array(z.string()).default([]),
    /** Vault item ids or "<type>:*" (e.g. "login:*" — still limited by each item's scope). */
    vault: z.array(z.string()).default([]),
    /** Core API methods this plugin may call (see CORE_METHODS). */
    core: z.array(z.string()).default([]),
    /** UI capabilities, informational for the install dialog. */
    ui: z.array(z.string()).default([]),
    /** Extra filesystem paths (informational). */
    fs: z.array(z.string()).default([]),
  })
  .default({ network: [], vault: [], core: [], ui: [], fs: [] });

/** A secret a plugin needs. The user types it into the chat; it lands in the vault under `vault`. */
export const SetupSecretSchema = z.object({
  /** Vault item id; must also be listed in permissions.vault. */
  vault: z.string().regex(/^[A-Za-z0-9][\w.-]{0,127}$/),
  /** Plugin setting that receives "vault://<vault>". */
  setting: z.string().optional(),
  title: z.string(),
  /** Where to get it (markdown). */
  hint: z.string().optional(),
  link: httpsUrl.optional(),
  /** Regular expression for the whole value: lets the hub recognise it when the user pastes it into a message. */
  pattern: z.string().optional(),
  required: z.boolean().default(false),
});
export type SetupSecret = z.infer<typeof SetupSecretSchema>;

/**
 * The outside service an integration goes through (Composio): every card of the plugin carries its badge, and the
 * badge's note says what that means.
 */
export const IntegrationViaSchema = z.object({
  name: z.string().min(1),
  /** The note ("%key%" of the plugin's locales); `{name}` is the card's own name. */
  about: z.string().min(1),
  link: httpsUrl.optional(),
});

/** The id of one of a plugin's catalog entries ("slack"); the catalog shows it as "<plugin>:<entry>". */
export const ENTRY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** A catalog entry of its own that a plugin has besides its card (Slack, GitHub… of the Composio plugin). */
export const IntegrationEntrySchema = z.object({
  id: z.string().regex(ENTRY_ID_RE),
  name: z.string().min(1),
  summary: z.string().optional(),
  category: z.string().default("other"),
  icon: z.string().default("puzzle"),
  /** The service's logo, a PNG in the plugin's folder ("./logos/slack.png", 128×128): drawn instead of the icon. */
  logo: relPath.optional(),
  example: z.string().optional(),
  popular: z.number().int().positive().optional(),
});
export type IntegrationEntry = z.infer<typeof IntegrationEntrySchema>;

/** A plugin shown in the catalog (and the integrations library): how it is connected and what it looks like. */
export const IntegrationSchema = z.object({
  /** The catalog's group: a situation in life (everyday, travel, money, work, reading, communication, home) or assistant. */
  category: z.string().default("other"),
  /** A lucide icon name. */
  icon: z.string().default("puzzle"),
  /** The service's logo, a PNG in the plugin's folder ("./logo.png", 128×128): drawn instead of the icon. */
  logo: relPath.optional(),
  /**
   * google: the hub's Google sign-in; setup: the plugin's setup card; signin: its MCP server's own sign-in in the
   * browser (OAuth, e.g. Granola); none: works as it is.
   */
  connect: z.enum(["google", "setup", "signin", "none"]).default("none"),
  /** OAuth scopes the plugin needs from the provider (connect: google). */
  scopes: z.array(z.string()).default([]),
  /** One line under the name in the library ("%key%" for a translation). */
  summary: z.string().optional(),
  /** Something to ask once it is on, in the person's words ("%key%"): the catalog's "Try" sends it to the assistant. */
  example: z.string().optional(),
  /** A built-in plugin's place among the catalog's popular ones (1 = first) until the person's own use ranks them. */
  popular: z.number().int().positive().optional(),
  /** The outside service it goes through: a badge on its card and on every entry's. */
  via: IntegrationViaSchema.optional(),
  /**
   * Entries of their own besides the plugin's card, shown even while it is off. The running plugin reports their
   * state, and entries it adds, with ctx.catalog.update; sign-in goes to its ctx.catalog.onSignIn.
   */
  entries: z.array(IntegrationEntrySchema).default([]),
});
export type IntegrationInfo = z.infer<typeof IntegrationSchema>;

export const PiomioManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "id: lowercase letters, digits, dashes"),
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().default(""),
  author: z.string().optional(),
  server: relPath.optional(),
  ui: relPath.optional(),
  /** Tool-name prefix; defaults to id with dashes replaced by underscores. */
  toolPrefix: z.string().regex(/^[a-zA-Z0-9_]+$/).optional(),
  contributes: z
    .object({
      tools: z.boolean().default(false),
      brains: z.array(z.string()).default([]),
      channels: z.array(z.string()).default([]),
      triggers: z.array(z.string()).default([]),
      hooks: z.array(z.string()).default([]),
      /** Kinds of cards its tools show in the chat (PluginContext.widgets.show; drawn by ui.widgets.add). */
      widgets: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/)).default([]),
      http: z.boolean().default(false),
      /** JSON Schema for plugin settings, rendered as a form in the web UI. */
      settings: z.record(z.string(), z.unknown()).optional(),
      /** What the user provides before the plugin works; shown as a setup card in the chat. */
      setup: z
        .object({
          secrets: z.array(SetupSecretSchema).default([]),
        })
        .optional(),
    })
    .default({ tools: false, brains: [], channels: [], triggers: [], hooks: [], widgets: [], http: false }),
  permissions: PluginPermissionsSchema,
  /** Shown as a card in the integrations library. */
  integration: IntegrationSchema.optional(),
  /** Built-in plugins start enabled; third-party ones need confirmation. */
  builtin: z.boolean().default(false),
  /** False: a built-in plugin ships turned off and waits in the catalog until the person turns it on. */
  defaultEnabled: z.boolean().default(true),
});

export type PiomioManifest = z.infer<typeof PiomioManifestSchema>;
export type PluginPermissions = z.infer<typeof PluginPermissionsSchema>;

/** Core methods a plugin can be granted via permissions.core. */
export const CORE_METHODS = [
  "conversations.post", // post a message into a conversation
  "channels.inbound", // a user message arrived via a channel
  "tasks.create",
  "tasks.get",
  "tasks.list",
  "notify",
  "approvals.resolve",
  "settings.get",
  "agents.list",
  "ui.emit", // push a plugin event to web clients
  "vault.check", // check if a vault ref exists / is unlocked (metadata only)
  "machines.list", // the computers tasks run on (the hub's own first, id "local"); tasks.create's `machine` takes one
  "notifications.feedback", // apply a signed feedback button press (useful / less / off)
  "files.deliver", // write a file (in base64 chunks) into a session workspace's downloads/ folder
  "files.fetch", // read a file an agent hands the plugin from its workspace (base64), e.g. one to upload to a site
  "connections.token", // an access token of the hub's connection the plugin's integration uses (e.g. Google)
  "conversations.tell", // a note for an agent that it answers: wakes the task, else the dialog (the default agent's when none)
  "speech.transcribe", // the words of a short audio clip (base64), with the hub's speech-to-text; { check: true } says if one is set up
] as const;
export type CoreMethod = (typeof CORE_METHODS)[number];

export interface PluginLayout {
  dir: string;
  /** Which manifests exist. */
  formats: Array<"piomio" | "claude" | "codex">;
  manifest: PiomioManifest;
  serverEntry?: string;
  uiEntry?: string;
  skillsDir?: string;
  commandsDir?: string;
  agentsDir?: string;
  hooksFile?: string;
  mcpFile?: string;
  /** Translations from .piomio-plugin/locales/<locale>.json: "%key%" strings in the manifest, ctx.i18n, ui.i18n. */
  messages: Catalog;
}

/** Flat key → string maps from .piomio-plugin/locales/<locale>.json; malformed files are rejected. */
export function readPluginMessages(dir: string): Catalog {
  const out: Catalog = {};
  for (const locale of LOCALES) {
    const file = join(dir, ".piomio-plugin", "locales", `${locale}.json`);
    if (!existsSync(file)) continue;
    const parsed = z.record(z.string(), z.string()).safeParse(readJson(file));
    if (!parsed.success) throw new Error(`invalid .piomio-plugin/locales/${locale}.json: expected a flat object of strings`);
    out[locale] = parsed.data;
  }
  return out;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function inside(dir: string, p: string): string {
  const abs = resolve(dir, p);
  const rel = relative(dir, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes plugin dir: ${p}`);
  return abs;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^([^a-z])/, "p-$1")
      .slice(0, 40) || "plugin"
  );
}

/** Read a plugin directory in any supported format. Throws with a readable message on invalid manifests. */
export function readPluginLayout(dir: string): PluginLayout {
  const formats: PluginLayout["formats"] = [];
  const ob = join(dir, ".piomio-plugin", "plugin.json");
  const cl = join(dir, ".claude-plugin", "plugin.json");
  const cx = join(dir, ".codex-plugin", "plugin.json");
  let manifest: PiomioManifest | undefined;
  let foreign: any;

  if (existsSync(ob)) {
    formats.push("piomio");
    const parsed = PiomioManifestSchema.safeParse(readJson(ob));
    if (!parsed.success) throw new Error(`invalid .piomio-plugin/plugin.json: ${parsed.error.message}`);
    manifest = parsed.data;
  }
  if (existsSync(cl)) {
    formats.push("claude");
    foreign ??= readJson(cl);
  }
  if (existsSync(cx)) {
    formats.push("codex");
    foreign ??= readJson(cx);
  }
  if (!manifest) {
    if (!foreign) throw new Error("no plugin manifest found (.piomio-plugin, .claude-plugin or .codex-plugin)");
    manifest = PiomioManifestSchema.parse({
      id: slug(String(foreign.name ?? "plugin")),
      name: String(foreign.name ?? "plugin"),
      version: String(foreign.version ?? "0.0.0"),
      description: String(foreign.description ?? ""),
      author: typeof foreign.author === "string" ? foreign.author : foreign.author?.name,
    });
  }

  const pick = (p: string) => (existsSync(join(dir, p)) ? join(dir, p) : undefined);
  // Foreign manifests may point at custom dirs ("skills": "./skills/", "mcpServers": "./.mcp.json").
  const foreignSkills = typeof foreign?.skills === "string" ? inside(dir, foreign.skills) : undefined;
  const foreignMcp = typeof foreign?.mcpServers === "string" ? inside(dir, foreign.mcpServers) : undefined;

  return {
    dir,
    formats,
    manifest,
    serverEntry: manifest.server ? inside(dir, manifest.server) : undefined,
    uiEntry: manifest.ui ? inside(dir, manifest.ui) : undefined,
    skillsDir: foreignSkills && existsSync(foreignSkills) ? foreignSkills : pick("skills"),
    commandsDir: pick("commands"),
    agentsDir: pick("agents"),
    hooksFile: pick(join("hooks", "hooks.json")),
    mcpFile: foreignMcp && existsSync(foreignMcp) ? foreignMcp : pick(".mcp.json"),
    messages: readPluginMessages(dir),
  };
}

export function toolPrefixOf(m: PiomioManifest): string {
  return m.toolPrefix ?? m.id.replace(/-/g, "_");
}
