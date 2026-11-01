import { hostname } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { BUILTIN_GOOGLE_CLIENT, GOOGLE_ENDPOINTS, type GoogleClientConfig } from "./connections.ts";

export interface Config {
  dataDir: string;
  /** Google sign-in (connections.ts): Piomio's client unless PIOMIO_GOOGLE_* says otherwise. */
  google: GoogleClientConfig;
  host: string;
  port: number;
  consolePort: number;
  egressPort: number;
  /** The phones' HTTPS port (default port + 2), see server/device-app.ts. */
  devicePort: number;
  /** Where the device port listens: every interface by default, so phones reach it over Wi-Fi and Tailscale. */
  deviceHost: string;
  /** PIOMIO_DEVICES=0 closes the device port: phones then reach the hub only through the link. */
  devicesOff: boolean;
  /** PIOMIO_REPLICA_NAME: what this machine is called among the hub's replicas (cluster.ts). */
  replicaName: string;
  /** PIOMIO_NODE_URLS: where machines reach this replica (/node/ws, /mcp); unset: its machine address. */
  nodeUrls: string[];
  /** PIOMIO_DEVICE_URLS: addresses for the pairing QR ahead of the detected ones (Docker, reverse proxies). */
  deviceUrls: string[];
  /** URL users and nodes use to reach the main UI / API. */
  publicUrl: string;
  /** The hub's Tailscale node (remote.ts): PIOMIO_TAILNET_BIN, else packages/tailnet/bin/<platform>-<arch>/ in the app. */
  tailnetBin: string;
  /** The node's name in the tailnet, the link's first label (PIOMIO_TAILNET_HOSTNAME, default "piomio"). */
  tailnetHostname: string;
  /** The OSRM servers show_map asks for routes along roads (routing.ts): PIOMIO_ROUTER_URL, else OpenStreetMap Germany's. */
  routerUrl: string;
  /** URL of the isolated security console. */
  consoleUrl: string;
  /** URL that local child processes (plugins, brains) use to reach the hub. */
  internalUrl: string;
  allowedHosts: string[];
  appRoot: string;
  /**
   * Folders of built-in plugins: the hub's own (plugins/) and the integrations (integrations/). A subfolder starting
   * with "_" or "." is not a plugin; one with a SKILL.md is a skill the hub ships (integrations/_template).
   */
  builtinPluginsDirs: string[];
  builtinAgentsDir: string;
  webDist: string;
  /** The pages kit's build (packages/pages-kit/dist), which pages run on. */
  pagesKitDir: string;
  consoleDist: string;
  isolation: { users: boolean; hubUser: string; agentUser: string; pluginUser: string };
  egressEnforced: "iptables" | "proxy";
  /** Install missing Claude Code / Codex CLIs into <data>/tools on sign-in (desktop installers; never under isolation). */
  installClis: boolean;
  /**
   * Keep local CLI brains' own tools in their sandbox (macOS Seatbelt; BrainSessionOptions.confine). On by default on
   * macOS, where the brains run as the person; PIOMIO_SANDBOX_BRAINS=0 turns it off. A hub isolated by unix users
   * has its own walls.
   */
  sandboxBrains: boolean;
  /**
   * Model access through plain API keys (PIOMIO_API_KEYS=1): the API brain (plugins/brain-api), key mode of machines'
   * CLI brains and Codex with an OpenAI key. Off by default: agents think with the plans the person signs in to.
   */
  apiKeys: boolean;
  /**
   * HOME of the brain CLIs (claude, codex), where their logins live: <data>/home/agent, or PIOMIO_BRAIN_HOME. The
   * desktop app sets that to the user's own home, so a CLI they already signed in to works as is, and Claude Code on
   * macOS finds the login keychain (it looks for it through HOME). Never under user isolation.
   */
  brainHome: string;
  vaultPassphraseFile?: string;
  timezone: string;
  version: string;
  /** GitHub repository whose releases carry the desktop installers (`/download/desktop/<os>`). */
  releasesRepo: string;
  /**
   * Where packaging/linux/install.sh put this hub (PIOMIO_INSTALL_ROOT, set by its launcher): its versions, the link
   * to the one that runs, the launcher. Such a hub updates itself on the person's button (self-update.ts).
   */
  installRoot?: string;
  /** A release in the shape of GitHub's `releases/latest` to update from instead (PIOMIO_UPDATE_URL): a local check. */
  updateUrl?: string;
  /** For tests: skip starting builtin plugins. */
  plugins: "all" | "none" | string[];
}

const here = fileURLToPath(new URL(".", import.meta.url));
export const APP_ROOT = resolve(here, "..", "..", "..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const host = env.PIOMIO_HOST ?? "127.0.0.1";
  const port = Number(env.PIOMIO_PORT ?? 8080);
  const consolePort = Number(env.PIOMIO_CONSOLE_PORT ?? port + 1);
  const egressPort = Number(env.PIOMIO_EGRESS_PORT ?? 8089);
  const devicePort = Number(env.PIOMIO_DEVICE_PORT ?? port + 2);
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const publicUrl = (env.PIOMIO_PUBLIC_URL ?? `http://${displayHost}:${port}`).replace(/\/$/, "");
  const consoleUrl = (env.PIOMIO_CONSOLE_URL ?? `http://${new URL(publicUrl).hostname}:${consolePort}`).replace(/\/$/, "");
  const extraHosts = (env.PIOMIO_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = Array.from(
    new Set(["localhost", "127.0.0.1", "[::1]", displayHost.toLowerCase(), new URL(publicUrl).hostname, new URL(consoleUrl).hostname, ...extraHosts]),
  );
  const appRoot = env.PIOMIO_APP_ROOT ?? APP_ROOT;
  const cfg: Config = {
    dataDir: resolve(env.PIOMIO_DATA_DIR ?? join(appRoot, ".data")),
    host,
    port,
    consolePort,
    egressPort,
    devicePort,
    deviceHost: env.PIOMIO_DEVICE_HOST ?? "0.0.0.0",
    devicesOff: env.PIOMIO_DEVICES === "0",
    replicaName: (env.PIOMIO_REPLICA_NAME || hostname().split(".")[0] || "hub").slice(0, 40),
    nodeUrls: (env.PIOMIO_NODE_URLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    deviceUrls: (env.PIOMIO_DEVICE_URLS ?? "")
      .split(",")
      .map((u) => u.trim().replace(/\/$/, ""))
      .filter(Boolean),
    publicUrl,
    consoleUrl,
    tailnetBin:
      env.PIOMIO_TAILNET_BIN ?? join(appRoot, "packages", "tailnet", "bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "piomio-tailnet.exe" : "piomio-tailnet"),
    tailnetHostname: env.PIOMIO_TAILNET_HOSTNAME?.trim() || "piomio",
    routerUrl: (env.PIOMIO_ROUTER_URL ?? "https://routing.openstreetmap.de").replace(/\/$/, ""),
    internalUrl: `http://127.0.0.1:${port}`,
    google: {
      clientId: env.PIOMIO_GOOGLE_CLIENT_ID ?? BUILTIN_GOOGLE_CLIENT.clientId,
      clientSecret: env.PIOMIO_GOOGLE_CLIENT_SECRET ?? BUILTIN_GOOGLE_CLIENT.clientSecret,
      authUrl: env.PIOMIO_GOOGLE_AUTH_URL ?? GOOGLE_ENDPOINTS.authUrl,
      tokenUrl: env.PIOMIO_GOOGLE_TOKEN_URL ?? GOOGLE_ENDPOINTS.tokenUrl,
      revokeUrl: env.PIOMIO_GOOGLE_REVOKE_URL ?? GOOGLE_ENDPOINTS.revokeUrl,
      userinfoUrl: env.PIOMIO_GOOGLE_USERINFO_URL ?? GOOGLE_ENDPOINTS.userinfoUrl,
    },
    allowedHosts,
    appRoot,
    builtinPluginsDirs: [join(appRoot, "plugins"), join(appRoot, "integrations")],
    builtinAgentsDir: join(appRoot, "agents"),
    webDist: join(appRoot, "packages", "web", "dist"),
    pagesKitDir: join(appRoot, "packages", "pages-kit", "dist"),
    consoleDist: join(appRoot, "packages", "console", "dist"),
    isolation: {
      users: env.PIOMIO_ISOLATION === "users",
      hubUser: env.PIOMIO_HUB_USER ?? "piomio",
      agentUser: env.PIOMIO_AGENT_USER ?? "agent",
      pluginUser: env.PIOMIO_PLUGIN_USER ?? "plugin",
    },
    egressEnforced: env.PIOMIO_EGRESS_ENFORCED === "iptables" ? "iptables" : "proxy",
    installClis: env.PIOMIO_INSTALL_CLIS === "1" && env.PIOMIO_ISOLATION !== "users",
    sandboxBrains: env.PIOMIO_SANDBOX_BRAINS !== "0" && env.PIOMIO_ISOLATION !== "users" && process.platform === "darwin",
    apiKeys: env.PIOMIO_API_KEYS === "1",
    brainHome: "",
    vaultPassphraseFile: env.PIOMIO_VAULT_PASSPHRASE_FILE && existsSync(env.PIOMIO_VAULT_PASSPHRASE_FILE) ? env.PIOMIO_VAULT_PASSPHRASE_FILE : undefined,
    timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    version: appVersion(),
    releasesRepo: env.PIOMIO_RELEASES_REPO || "legostin/piomio",
    ...(env.PIOMIO_INSTALL_ROOT ? { installRoot: resolve(env.PIOMIO_INSTALL_ROOT) } : {}),
    ...(env.PIOMIO_UPDATE_URL ? { updateUrl: env.PIOMIO_UPDATE_URL } : {}),
    plugins: (env.PIOMIO_PLUGINS ?? "all") === "all" ? "all" : env.PIOMIO_PLUGINS === "none" ? "none" : (env.PIOMIO_PLUGINS ?? "").split(","),
  };
  const merged = { ...cfg, ...overrides };
  if (!overrides.brainHome) {
    merged.brainHome = env.PIOMIO_BRAIN_HOME && env.PIOMIO_ISOLATION !== "users" ? resolve(env.PIOMIO_BRAIN_HOME) : join(merged.dataDir, "home", "agent");
  }
  return merged;
}

/** The root package.json's version: the desktop installers on GitHub are released under it. */
function appVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version || "0.1.0");
  } catch {
    return "0.1.0";
  }
}

export function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
