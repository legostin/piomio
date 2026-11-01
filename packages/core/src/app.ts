// Hub composition root: builds every core service, wires them together, starts/stops servers.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, CatalogEntryState, Computer, ConnectionAccount, CoreMethod, DeviceNetwork, DevicePairing, Invite, ThinkingView } from "@piomio/shared";
import { DEFAULT_LOCALE, catalogLookup, formatBrainRef, localizeValue, normalizeLocale, parseBrainRef, toolPrefixOf } from "@piomio/shared";
import type { Config } from "./config.ts";
import { hubDbFile, openDb, type Db } from "./db.ts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { Settings, type CoreSettings } from "./settings.ts";
import { VaultService } from "./vault/service.ts";
import { AuditLog } from "./audit.ts";
import { RuleStore } from "./policy/rules.ts";
import { ApprovalService } from "./approvals.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { HookRegistry } from "./hooks.ts";
import { ToolGateway } from "./tools/gateway.ts";
import { AgentRegistry, agentFromMarkdown, agentName } from "./agents.ts";
import { AgentsStateStore } from "./agents-state.ts";
import { SkillHolders, SkillIndex } from "./skills.ts";
import { PluginHost } from "./plugins/host.ts";
import { EgressProxy } from "./egress.ts";
import { BrainRegistry } from "./brains.ts";
import { ChannelRegistry } from "./channels.ts";
import { Notifier } from "./notifier.ts";
import { SessionRunner } from "./runner.ts";
import { Team } from "./team.ts";
import { roadRoute } from "./routing.ts";
import { UserLocations } from "./user-location.ts";
import { announceUpdate } from "./updates.ts";
import { FEED_RUN_TOOLS, Feeds } from "./feeds.ts";
import { SetupChats } from "./setup-chats.ts";
import { registerFeedTools } from "./tools/feed-tools.ts";
import { registerThinkingTools } from "./tools/thinking-tools.ts";
import { thinkingView } from "./thinking.ts";
import { registerPageTools } from "./tools/page-tools.ts";
import { registerGroupTools } from "./tools/group-tools.ts";
import { registerNativePermission } from "./tools/native-permission.ts";
import { Pages } from "./pages.ts";
import { registerCoreTools } from "./tools/core-tools.ts";
import { McpEndpoint } from "./mcp/server.ts";
import { McpClientManager } from "./mcp/client.ts";
import { AuthService } from "./auth.ts";
import { DesktopTickets } from "./desktop-login.ts";
import { MachineHub } from "./machines.ts";
import { MachineSetups } from "./machine-setup.ts";
import { Cluster } from "./cluster.ts";
import { MachineActivityFeed } from "./activity.ts";
import { DeviceRegistry } from "./devices.ts";
import { InviteRegistry } from "./invites.ts";
import { deviceTls, type DeviceTls } from "./devices-tls.ts";
import { deviceUrls, hubName, inviteUrl, machineHubUrl, pairingLink, qrSvg } from "./pairing.ts";
import { createCoreCall } from "./core-call.ts";
import { configureHubLocale, coreCatalog, hubLocale, localizePluginValue, LocalizedError, t } from "./i18n.ts";
import { registerHubTools, slug } from "./tools/hub-tools.ts";
import { SecretIntake } from "./secrets.ts";
import { AgentDrafts } from "./agent-drafts.ts";
import { BrainLogins } from "./brain-login.ts";
import { CliTools } from "./cli-tools.ts";
import { UserPath } from "./user-path.ts";
import { SetupGuide } from "./setup.ts";
import { MediaService } from "./media.ts";
import { Connections } from "./connections.ts";
import { entryRef } from "./integrations.ts";
import { cleanTranscription, Transcriber } from "./transcribe.ts";
import { RemoteAccess } from "./remote.ts";
import { buildMainApp } from "./server/main-app.ts";
import { buildConsoleApp } from "./server/console-app.ts";
import { buildDeviceApp } from "./server/device-app.ts";
import type { FastifyInstance } from "fastify";

/** How long a chat waits to hear about an entry's sign-in it started. */
const ENTRY_SIGNIN_MS = 30 * 60_000;

export class Hub {
  config: Config;
  db: Db;
  bus = new EventBus();
  store: Store;
  settings: Settings;
  vault: VaultService;
  audit: AuditLog;
  rules: RuleStore;
  approvals: ApprovalService;
  tools = new ToolRegistry();
  hooks = new HookRegistry();
  gateway: ToolGateway;
  agents: AgentRegistry;
  /** Pinned, archived and deleted built-in agents (agents-state.ts). */
  agentsState: AgentsStateStore;
  skills = new SkillIndex();
  egress = new EgressProxy();
  brains = new BrainRegistry();
  channels: ChannelRegistry;
  notifier: Notifier;
  runner: SessionRunner;
  team: Team;
  /** The user's channels: news an agent gathers on a schedule (feeds.ts). */
  feeds: Feeds;
  /** Pages agents make (pages.ts). */
  pages: Pages;
  /** "New channel" and "Add agent" chats (setup-chats.ts). */
  setupChats: SetupChats;
  plugins: PluginHost;
  mcp: McpEndpoint;
  mcpClients: McpClientManager;
  auth: AuthService;
  /** One-time sign-in tickets from the desktop app (see desktop-login.ts). */
  desktopTickets = new DesktopTickets();
  /** One-time invites: one link connects a computer or a phone (invites.ts). */
  invites: InviteRegistry;
  machines: MachineHub;
  setups: MachineSetups;
  /** This hub's place among its replicas (cluster.ts); a hub of one always leads. */
  cluster: Cluster;
  /** What every machine is doing now, for the machines block (activity.ts). */
  activity: MachineActivityFeed;
  /** Phones paired with the hub (the Piomio app) and the device port they talk to. */
  devices: DeviceRegistry;
  /** Where the user is, when their phone shares it (user-location.ts). */
  locations: UserLocations;
  deviceApp?: FastifyInstance;
  private deviceError?: string;
  private deviceSync: Promise<unknown> = Promise.resolve();
  secrets: SecretIntake;
  agentDrafts: AgentDrafts;
  brainLogins: BrainLogins;
  cliTools: CliTools;
  /** Where the user's own CLIs live (their shell or account PATH): read on desktop installs, which start with a short PATH. */
  userPath = new UserPath();
  setup: SetupGuide;
  /** External images and OpenStreetMap tiles the web UI shows, fetched and cached by the hub. */
  media: MediaService;
  connections: Connections;
  transcriber: Transcriber;
  /** Access from anywhere: the hub's Tailscale node and its link (remote.ts). */
  remote: RemoteAccess;
  /** The link's gateways on loopback: the web UI and the phones, behind the node. */
  private remoteGateways?: { web: FastifyInstance; device: FastifyInstance; ports: { web: number; device: number } };
  mainApp?: FastifyInstance;
  consoleApp?: FastifyInstance;
  private timers: NodeJS.Timeout[] = [];

  constructor(config: Config) {
    this.config = config;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = openDb(hubDbFile(config.dataDir));
    this.skills.holders = new SkillHolders(this.db);
    this.store = new Store(this.db, this.bus);
    this.settings = new Settings(this.db, config.timezone);
    configureHubLocale(() => normalizeLocale(this.settings.get().language) ?? DEFAULT_LOCALE);
    this.vault = new VaultService(join(config.dataDir, "vault.db"), {
      onState: (state) => this.bus.emit("vault.state", { state }),
      onAccess: (e) =>
        this.audit.append(e.actor, e.allowed ? "vault.access" : "vault.denied", e.itemId, e.reason ? { reason: e.reason, ...(e.repeats ? { repeats: e.repeats } : {}) } : undefined),
      // Every change, wherever it comes from (security console, chat, Google sign-in): plugins waiting for a key
      // (the Telegram token, an API key) react to this instead of asking the vault again and again.
      onChange: (ids) => this.bus.emit("vault.updated", { ids }),
    });
    this.audit = new AuditLog(this.db, this.vault.redactor);
    this.egress.audit = this.audit;
    this.egress.extraBrainAllow = () => this.settings.get().brainEgressAllow;
    this.egress.privateAllow = () => this.settings.get().egressPrivateAllow;
    this.rules = new RuleStore(this.db);
    this.approvals = new ApprovalService(this.db, this.bus, this.audit, this.rules);
    this.agents = new AgentRegistry(config.builtinAgentsDir, join(config.dataDir, "agents"));
    this.agentsState = new AgentsStateStore(this.settings);
    this.agents.state = () => this.agentsState.get();
    this.channels = new ChannelRegistry(this.vault.redactor);
    this.notifier = new Notifier({
      db: this.db,
      bus: this.bus,
      settings: this.settings,
      channels: this.channels,
      hooks: this.hooks,
      store: this.store,
      sign: (p) => this.approvals.sign(p),
      publicUrl: config.publicUrl,
      hasAgent: (id) => !!this.agents.get(id),
      // The default agent writes the digest: a quiet background task on a fast model. Its goal carries other runs' words
      // and channel headlines, so it is marked as reading outside content before the brain sees it.
      startTask: (job) => this.runner.createTask({ ...job, background: true, createdBy: "trigger", tainted: true, thinking: { preset: "fast", skill: "writing" } }),
      // Once the card went out instead of its reply, the writer is stopped.
      cancelTask: (id) => void this.runner.cancelTask(id),
      agentName: (id) => {
        const a = this.agents.get(id);
        return a ? agentName(a, hubLocale()) : id;
      },
    });
    this.gateway = new ToolGateway({
      store: this.store,
      registry: this.tools,
      hooks: this.hooks,
      rules: this.rules,
      approvals: this.approvals,
      audit: this.audit,
      redactor: this.vault.redactor,
      settings: this.settings,
      agents: this.agents,
      workspaceFor: (s) => this.runner.workspacePath(s),
      jobTools: (s) => (s.taskId && this.store.getTask(s.taskId)?.feedId ? FEED_RUN_TOOLS : []),
      skills: this.skills,
      // "%key%" approval summaries resolve against the owner's messages in the hub language.
      localize: (owner, text) =>
        owner === "core" ? localizeValue(text, catalogLookup(coreCatalog, hubLocale())) : localizePluginValue(this.plugins.get(owner)?.layout, text, hubLocale()),
    });
    this.invites = new InviteRegistry({ db: this.db, bus: this.bus, audit: this.audit });
    this.setups = new MachineSetups({ db: this.db, bus: this.bus, audit: this.audit, vault: () => this.vault });
    this.machines = new MachineHub({ db: this.db, bus: this.bus, brains: this.brains, audit: this.audit, invites: this.invites, setups: this.setups });
    this.cluster = new Cluster(this);
    this.machines.cluster = this.cluster;
    this.activity = new MachineActivityFeed(this.bus, this.machines);
    this.devices = new DeviceRegistry({ db: this.db, bus: this.bus, audit: this.audit, invites: this.invites });
    this.locations = new UserLocations(this.settings, (id) => !!this.devices.get(id));
    this.secrets = new SecretIntake({ db: this.db, bus: this.bus, audit: this.audit, vault: this.vault, plugins: () => this.plugins });
    this.agentDrafts = new AgentDrafts({ db: this.db, bus: this.bus });
    this.cliTools = new CliTools(config.dataDir, config.installClis);
    this.brainLogins = new BrainLogins({ brains: this.brains, bus: this.bus, egress: this.egress, audit: this.audit, egressPort: () => this.config.egressPort, tools: this.cliTools });
    // The vault holds the keys; a sealed vault means no speech-to-text until it is unlocked.
    this.transcriber = new Transcriber({
      settings: () => this.settings.get().transcription,
      hasSecret: (id) => this.vault.state() === "unlocked" && !!this.vault.getMeta(id),
      secret: (ref) => this.vault.access(ref, { actor: "core:transcription" }).value ?? "",
    });
    this.runner = new SessionRunner({
      config,
      store: this.store,
      settings: this.settings,
      agents: this.agents,
      brains: this.brains,
      skills: this.skills,
      hooks: this.hooks,
      notifier: this.notifier,
      channels: this.channels,
      audit: this.audit,
      bus: this.bus,
      redactor: this.vault.redactor,
      gateway: this.gateway,
      approvals: this.approvals,
      egress: this.egress,
      claudePluginDirs: () => this.plugins.enabledLayouts().filter((l) => l.formats.includes("claude") && !l.manifest.builtin).map((l) => l.dir),
      machineName: (id) => this.machines.name(id) ?? this.replicaName(id),
      machines: () => this.machines.list(),
      here: () => this.here(),
      activity: this.activity,
      locations: this.locations,
      secrets: this.secrets,
      transcriber: this.transcriber,
      toolNames: () =>
        this.tools
          .list()
          .map((t) => t.name)
          .join(","),
    });
    this.setup = new SetupGuide({
      brains: this.brains,
      agents: this.agents,
      settings: this.settings,
      store: this.store,
      vault: this.vault,
      channels: this.channels,
      machines: this.machines,
      cliTools: this.cliTools,
      bus: this.bus,
      isRunning: (id) => this.runner.isRunning(id),
      resume: (id, prompt, opts) => this.runner.resume(id, prompt, opts),
      tellAgent: (id, note) => this.runner.tellAgent(id, note),
    });
    this.runner.d.setup = this.setup;
    this.team = new Team({
      store: this.store,
      agents: this.agents,
      pinned: () => this.agentsState.get().pinned,
      bus: this.bus,
      isRunning: (id) => this.runner.isRunning(id),
      floor: (id) => this.runner.floor(id),
    });
    this.setupChats = new SetupChats({ store: this.store, bus: this.bus, settings: this.settings });
    this.feeds = new Feeds({
      db: this.db,
      bus: this.bus,
      settings: this.settings,
      agents: this.agents,
      createTask: (task) => this.runner.createTask(task),
      getTask: (id) => this.store.getTask(id),
    });
    this.pages = new Pages({ db: this.db, bus: this.bus, dir: join(config.dataDir, "pages") });
    this.mcpClients = new McpClientManager({ config, registry: this.tools, vault: this.vault, audit: this.audit, egress: this.egress });
    this.plugins = new PluginHost({
      config,
      db: this.db,
      bus: this.bus,
      tools: this.tools,
      hooks: this.hooks,
      vault: this.vault,
      audit: this.audit,
      egress: this.egress,
      brains: this.brains,
      channels: this.channels,
      coreCall: createCoreCall(this),
      onLayoutsChanged: () => this.reindex(),
      // The user's own CLIs first, then the ones the hub installed: a CLI the user installed wins.
      cliBinDirs: () => [...this.userPath.dirs(), ...this.cliTools.binDirs()],
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
      onCatalogUpdated: (pluginId, before, after) => this.catalogUpdated(pluginId, before, after),
    });
    this.mcp = new McpEndpoint(this.gateway, this.store, config.version);
    this.media = new MediaService({ dataDir: config.dataDir, version: config.version, resolve: (host) => this.egress.resolveTarget(host) });
    this.connections = new Connections({
      google: config.google,
      vault: this.vault,
      settings: this.settings,
      bus: this.bus,
      audit: this.audit,
      redirectUri: () => `${this.config.internalUrl}/oauth/callback`,
    });
    const rpId = new URL(config.publicUrl).hostname;
    this.auth = new AuthService(this.db, this.audit, {
      rpId,
      origins: [new URL(config.publicUrl).origin, new URL(config.consoleUrl).origin],
      setupToken: process.env.PIOMIO_SETUP_TOKEN,
    });
    this.auth.onRemotePause = () => {
      void this.notifier.notify({ level: "notify", title: t("remote.pausedTitle"), body: t("remote.pausedBody") }).catch(() => {});
    };
    this.remote = new RemoteAccess({
      config,
      settings: this.settings,
      bus: this.bus,
      deviceTls: () => this.deviceTls(),
      gateways: { start: () => this.startRemoteGateways(), stop: () => this.stopRemoteGateways() },
      hasPassword: () => this.auth.hasPassword(),
    });
    // The link is one of the phones' addresses: the Devices page follows it.
    this.bus.on("remote.updated", () => this.bus.emit("devices.network", this.deviceNetwork()));
    registerCoreTools({
      registry: this.tools,
      skills: this.skills,
      vault: this.vault,
      store: this.store,
      notifier: this.notifier,
      agents: this.agents,
      createTask: (t) => this.runner.createTask(t),
      tasks: {
        place: (agentId, machine) => this.runner.placeTask(agentId, machine),
        ask: (taskId, question) => this.runner.askStarter(taskId, question),
        message: (taskId, text, from) => this.runner.messageTask(taskId, text, from),
        cancel: (taskId, from) => this.runner.cancelTaskFrom(taskId, from),
        computers: () => this.runner.computers(),
        team: () => this.runner.teamNow(),
        teammate: (to, text, from) => this.runner.messageTeammate(to, text, from),
      },
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
      showToPerson: (conversationId, part, taskId) => this.runner.showToPerson(conversationId, part, taskId),
      startedWorkspaces: (conversationId) => this.runner.startedWorkspaces(conversationId),
      workspacesRoot: join(config.dataDir, "workspaces"),
      transcriber: this.transcriber,
      route: (mode, stops) => roadRoute(config.routerUrl, mode, stops),
      userLocation: () => this.locations.get(),
    });
    this.machines.registerTools(this.tools);
    registerHubTools(this);
    registerFeedTools({
      registry: this.tools,
      feeds: this.feeds,
      store: this.store,
      agents: this.agents,
      timezone: () => this.settings.get().timezone,
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
    });
    registerThinkingTools({
      registry: this.tools,
      agents: this.agents,
      view: (a) => this.thinkingView(a),
      save: (a, actor) => this.saveAgent(a, actor),
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
    });
    registerGroupTools({ registry: this.tools, store: this.store, agents: this.agents });
    registerNativePermission({
      registry: this.tools,
      approvals: this.approvals,
      rules: this.rules,
      store: this.store,
      settings: this.settings,
      audit: this.audit,
      redactor: this.vault.redactor,
      agents: this.agents,
      dataDir: config.dataDir,
      roots: () => this.plugins.enabledLayouts().filter((l) => l.formats.includes("claude") && !l.manifest.builtin).map((l) => l.dir),
    });
    registerPageTools({
      registry: this.tools,
      pages: this.pages,
      agents: this.agents,
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
    });
    // A brain signed in from a card the assistant showed: the assistant hears it and carries on.
    this.brainLogins.onSignedIn = (s, label, conversationId) =>
      this.runner.tellAgent(conversationId, `[System] The user signed ${label} (${s.ref}) in from the chat card; it is ready now. Carry on with what it was needed for.`);
    this.brains.onChange = () => this.bus.emit("brains.updated", {});
    // A key or token saved from the chat may sign a brain in: check again now, not in five minutes.
    this.bus.on("vault.updated", () => {
      this.brains.invalidateAll();
      this.bus.emit("brains.updated", {});
    });
    this.wireChannelsForApprovals();
  }

  /** A Google account was connected: the agent whose chat showed the card hears it and carries on. */
  connectionDone(account: ConnectionAccount, origin?: { integration?: string; conversationId?: string }): void {
    if (!origin?.conversationId || !this.store.getConversation(origin.conversationId)) return;
    const what = origin.integration ? ` (${origin.integration})` : "";
    this.runner.tellAgent(origin.conversationId, `[System] The user connected Google as ${account.account}${what}; it works now. Carry on with what it was needed for.`);
  }

  /** Every settings change (web UI or the assistant's hub tools): validation, audit, language broadcast, live UI refresh. */
  updateSettings(patch: Record<string, unknown>, actor: string): CoreSettings {
    const p = { ...patch };
    if ("language" in p) {
      const l = normalizeLocale(p.language);
      if (!l) throw new LocalizedError("settings.badLanguage", { value: String(p.language) }, 400);
      p.language = l;
    }
    if ("defaultAgent" in p && !this.agents.get(String(p.defaultAgent))) throw new LocalizedError("agent.notFound", undefined, 400);
    if ("defaultAgent" in p && this.agents.isArchived(String(p.defaultAgent))) throw new LocalizedError("agent.archivedDefault", undefined, 400);
    if ("transcription" in p) {
      const t = cleanTranscription(p.transcription);
      if (typeof t === "string") throw new LocalizedError("settings.badTranscription", { reason: t }, 400);
      p.transcription = t;
    }
    const before = this.settings.get().language;
    this.audit.append(actor, "settings.update", undefined, { keys: Object.keys(p) });
    const next = this.settings.update(p as Partial<CoreSettings>);
    if (next.language !== before) {
      this.plugins.broadcastLocale(next.language);
      this.machines.broadcastLocale(next.language);
      this.brains.invalidateAll();
    }
    this.bus.emit("settings.updated", { keys: Object.keys(p) });
    return next;
  }

  /** The device port's identity (made on first use) and state, for the web UI and the pairing QR. */
  deviceTls(): DeviceTls {
    return deviceTls(this.config.dataDir);
  }

  deviceNetwork(): DeviceNetwork {
    return {
      enabled: !this.config.devicesOff,
      listening: !!this.deviceApp,
      port: this.config.devicePort,
      urls: deviceUrls(this.config.devicePort, this.config.deviceUrls, undefined, this.remote.deviceLink()),
      ...(this.deviceError ? { error: this.deviceError } : {}),
    };
  }

  /** Start the device port unless PIOMIO_DEVICES=0 closed it; calls are serialized. */
  syncDeviceServer(): Promise<DeviceNetwork> {
    const run = async () => {
      const want = !this.config.devicesOff;
      if (want && !this.deviceApp) {
        this.deviceError = undefined;
        const app = await buildDeviceApp(this, this.deviceTls());
        try {
          await app.listen({ host: this.config.deviceHost, port: this.config.devicePort });
          this.deviceApp = app;
          console.log(`[piomio] devices: https://${this.config.deviceHost}:${this.config.devicePort}`);
        } catch (e: any) {
          this.deviceError = e?.code === "EADDRINUSE" ? t("device.portInUse", { port: this.config.devicePort }) : String(e?.message ?? e);
          await app.close().catch(() => {});
        }
      } else if (!want && this.deviceApp) {
        const app = this.deviceApp;
        this.deviceApp = undefined;
        await app.close();
      }
      const state = this.deviceNetwork();
      this.bus.emit("devices.network", state);
      return state;
    };
    const next = this.deviceSync.then(run, run);
    this.deviceSync = next.catch(() => {});
    return next;
  }

  /** Where a phone can reach the hub now: the device port's addresses while it listens, and the link while it is up. */
  phoneUrls(): string[] {
    const link = this.remote.deviceLink();
    if (this.deviceApp) return deviceUrls(this.config.devicePort, this.config.deviceUrls, undefined, link);
    return link ? [link] : [];
  }

  /** The phone's link for an invite code, while phones can reach the hub (the device port or the link). */
  phoneLink(code: string): string | undefined {
    const urls = this.phoneUrls();
    return urls.length ? pairingLink({ code, hubName: hubName(), fingerprint: this.deviceTls().fingerprint, urls }) : undefined;
  }

  /** One invite for any device: the shareable /join link and, while phones can reach the hub, the phone's QR. */
  createInvite(): Invite {
    const { code, expiresAt } = this.invites.create();
    const url = inviteUrl(machineHubUrl(this.config.publicUrl, this.remote.link()), code);
    const phoneLink = this.phoneLink(code);
    return { code, expiresAt, ...(url ? { url } : {}), ...(phoneLink ? { phoneLink, qrSvg: qrSvg(phoneLink) } : {}) };
  }

  /** A one-time code and the QR for a phone; the device port or the link must be up. */
  devicePairing(): DevicePairing {
    const network = this.deviceNetwork();
    if (!network.listening && !this.remote.deviceLink()) throw new LocalizedError("device.networkOff", undefined, 409);
    const urls = this.phoneUrls();
    if (!urls.length) throw new LocalizedError("device.noAddress", undefined, 409);
    const { fingerprint } = this.deviceTls();
    const { code, expiresAt } = this.devices.createPairingCode();
    const link = pairingLink({ code, hubName: hubName(), fingerprint, urls });
    return { code, expiresAt, link, qrSvg: qrSvg(link), urls, fingerprint };
  }

  /** The link's gateways (remote.ts): the web UI and the phones' API on loopback ports only the node is told. */
  private async startRemoteGateways(): Promise<{ web: number; device: number }> {
    if (this.remoteGateways) return this.remoteGateways.ports;
    const web = await buildMainApp(this, { remote: { host: () => this.remote.linkHost() } });
    const device = await buildDeviceApp(this, this.deviceTls(), { remote: true });
    try {
      await web.listen({ host: "127.0.0.1", port: 0 });
      await device.listen({ host: "127.0.0.1", port: 0 });
    } catch (e) {
      await web.close().catch(() => {});
      await device.close().catch(() => {});
      throw e;
    }
    const port = (app: FastifyInstance) => (app.server.address() as { port: number }).port;
    this.remoteGateways = { web, device, ports: { web: port(web), device: port(device) } };
    return this.remoteGateways.ports;
  }

  private async stopRemoteGateways(): Promise<void> {
    const g = this.remoteGateways;
    this.remoteGateways = undefined;
    await g?.web.close();
    await g?.device.close();
  }

  /** Where "unlock automatically after restarts" keeps the vault passphrase (hub-only file, like a Docker secret). */
  rememberedPassphraseFile(): string {
    return join(this.config.dataDir, "vault.passphrase");
  }

  /** Remember the passphrase for automatic unlock, or forget it (undefined). */
  rememberVaultPassphrase(passphrase: string | undefined): void {
    const file = this.rememberedPassphraseFile();
    if (passphrase === undefined) rmSync(file, { force: true });
    else writeFileSync(file, passphrase, { mode: 0o600 });
  }

  /** "Check again" on the setup card: look for the user's CLIs again (restarting the brain hosts when they moved) and re-probe. */
  async refreshBrains(): Promise<void> {
    if (this.config.installClis && (await this.userPath.refresh())) {
      for (const r of this.plugins.list()) {
        if (r.enabled && r.source === "builtin" && r.layout?.manifest.contributes.brains.length) await this.plugins.restart(r.id).catch(() => {});
      }
    }
    this.brains.invalidateAll();
    this.bus.emit("brains.updated", {});
  }

  /** How an agent thinks for each kind of work, on the brains here (thinking.ts). */
  thinkingView(agent: AgentDef): Promise<ThinkingView> {
    return thinkingView(this.brains, this.db, agent, this.here());
  }

  saveAgent(agent: AgentDef, actor: string): AgentDef {
    // The order its conversations try brains in: the agent's, the brain each kind of work prefers, and its computers.
    const refs = (a: AgentDef | undefined) =>
      a && [...a.brains, ...Object.values(a.thinking ?? {}).map((c) => c?.brain ?? "")].map((b) => (b ? formatBrainRef(parseBrainRef(b)) : "")).join("\n") + `\n@${(a.machines ?? []).join(",")}`;
    const before = this.agents.get(agent.id);
    // Computers by id: a name, "local" or the hub's name become the id the binding keeps (one it does not know stays as written).
    const machines = [...new Set((agent.machines ?? []).map((m) => this.resolveComputer(m) ?? m.trim()).filter(Boolean))];
    const { machines: _, archived: __, ...rest } = agent;
    // Made anew under the id of a deleted built-in one: it is back.
    if (this.agentsState.get().removed.includes(rest.id)) this.agentsState.set("removed", rest.id, false);
    const saved = this.agents.save(machines.length ? { ...rest, machines } : rest);
    if (before && refs(before) !== refs(saved)) this.runner.brainsChanged(saved.id);
    this.audit.append(actor, "agent.save", saved.id);
    this.bus.emit("agents.updated", {});
    return saved;
  }

  /** The id an agent's binding (AgentDef.machines) names this hub's computer by: its replica id in a cluster, else "local". */
  here(): string {
    return this.cluster.identity?.id ?? "local";
  }

  /** Another replica's name (the replicas table travels to every replica). */
  private replicaName(id: string): string | undefined {
    return (this.db.prepare("select name from replicas where id = ? and revoked = 0").get(id) as { name: string } | undefined)?.name;
  }

  /**
   * The computers an agent may be bound to: this hub's own first, the paired machines, then the hub's other replicas
   * (on standby: nothing runs there while this one leads).
   */
  computers(): Computer[] {
    const here = this.here();
    const replicas = this.db.prepare("select id, name from replicas where revoked = 0 and id != ? order by priority").all(here) as Array<{ id: string; name: string }>;
    return [
      { id: here, name: hubName(), online: true },
      ...this.machines.list().map((m) => ({ id: m.id, name: m.name, online: m.status === "online" })),
      ...replicas.map((r) => ({ id: r.id, name: r.name, online: false, standby: true })),
    ];
  }

  /** A computer by id or name ("local" is this hub's), as an agent's binding keeps it; undefined when there is none. */
  resolveComputer(idOrName: string): string | undefined {
    const key = idOrName.trim().toLowerCase();
    if (!key) return undefined;
    if (key === "local") return this.here();
    const list = this.computers();
    return (list.find((c) => c.id.toLowerCase() === key) ?? list.find((c) => c.name.toLowerCase() === key))?.id;
  }

  /** A draft from the chat joins the team under a fresh id derived from its name; it never replaces an existing agent. */
  createAgentFromDraft(draftId: string, actor: string): AgentDef {
    const d = this.agentDrafts.open(draftId);
    const base = slug(d.name);
    let id = base;
    for (let n = 2; this.agents.get(id); n++) id = `${base.slice(0, 36)}-${n}`;
    const saved = this.saveAgent(
      {
        ...agentFromMarkdown(id, "", "user"),
        id,
        name: d.name,
        description: d.description,
        prompt: d.prompt,
        avatar: d.avatar,
        brains: d.brains,
        ...(d.initiative !== undefined ? { initiative: d.initiative } : {}),
        source: "user",
      },
      actor,
    );
    this.agentDrafts.markCreated(d.id, saved.id);
    return saved;
  }

  /** Pinned agents sit under the default agent at the top of the list, in the order they were pinned. */
  pinAgent(id: string, pinned: boolean, actor: string): void {
    if (!this.agents.get(id)) throw new LocalizedError("agent.notFound", undefined, 404);
    this.agentsState.set("pinned", id, pinned);
    this.audit.append(actor, pinned ? "agent.pin" : "agent.unpin", id);
    this.bus.emit("agents.updated", {});
  }

  /**
   * The default agent cannot sleep or leave without someone in its place: `successor`, an agent of the team other than
   * it, becomes the default first. Returns the default agent after the step.
   */
  private handOver(id: string, successor: string | undefined, actor: string): string {
    const current = this.settings.get().defaultAgent;
    if (current !== id) return current;
    const next = successor ? this.agents.get(successor) : undefined;
    if (!next || next.id === id || this.agents.isArchived(next.id)) throw new LocalizedError("agent.successorNeeded", { name: agentName(this.agents.get(id)!, this.settings.get().language) }, 400);
    this.updateSettings({ defaultAgent: next.id }, actor);
    return next.id;
  }

  /**
   * The archive: the agent sleeps (agents-state.ts). Out of the team, its turn and tasks stop, its schedules and channel
   * runs are skipped; its dialog, memory and settings stay, and it comes back as it was.
   */
  archiveAgent(id: string, archived: boolean, opts: { successor?: string }, actor: string): { defaultAgent: string } {
    if (!this.agents.get(id)) throw new LocalizedError("agent.notFound", undefined, 404);
    const defaultAgent = archived ? this.handOver(id, opts.successor, actor) : this.settings.get().defaultAgent;
    this.agentsState.set("archived", id, archived);
    if (archived) this.runner.stopAgent(id);
    this.audit.append(actor, archived ? "agent.archive" : "agent.restore", id);
    this.bus.emit("agents.updated", {});
    return { defaultAgent };
  }

  /**
   * The agent leaves for good with its dialog, tasks and schedules (plugins hear "agent.removed"); the channels it edited
   * pass to the default agent. A built-in or plugin agent is remembered as deleted, since its file ships with the hub.
   */
  deleteAgent(id: string, opts: { successor?: string }, actor: string): { defaultAgent: string } {
    const agent = this.agents.get(id);
    if (!agent) throw new LocalizedError("agent.notFound", undefined, 404);
    const defaultAgent = this.handOver(id, opts.successor, actor);
    this.runner.stopAgent(id);
    this.agents.remove(id);
    this.agentsState.forget(id);
    if (this.agents.shipped(id)) this.agentsState.set("removed", id, true);
    this.feeds.handOver(id, defaultAgent);
    this.store.deleteAgentData(id);
    this.skills.holders?.dropAgent(id);
    this.audit.append(actor, "agent.delete", id, { name: agent.name });
    this.bus.emit("agent.removed", { agentId: id });
    this.bus.emit("agents.updated", {});
    this.bus.emit("skills.updated", {});
    return { defaultAgent };
  }

  /** Skills, commands, agents and MCP servers come from enabled plugin layouts + data dir. */
  reindex(): void {
    const layouts = this.plugins?.enabledLayouts() ?? [];
    this.skills.setRoots([
      // Skills the hub ships sit beside its built-in plugins (integrations/_template is make-integration).
      ...this.config.builtinPluginsDirs.map((dir) => ({ source: "piomio", skillsDir: dir })),
      { source: "user", skillsDir: join(this.config.dataDir, "skills"), commandsDir: join(this.config.dataDir, "commands") },
      ...layouts.map((l) => ({ source: l.manifest.id, skillsDir: l.skillsDir, commandsDir: l.commandsDir })),
    ]);
    this.agents.pluginDirs = layouts.filter((l) => l.agentsDir).map((l) => ({ pluginId: l.manifest.id, dir: l.agentsDir! }));
    this.agents.reload();
    if (this.started) {
      void this.mcpClients.sync(this.pluginMcpFiles());
    }
  }

  private pluginMcpFiles() {
    return (this.plugins?.list() ?? [])
      .filter((r) => r.enabled && r.layout?.mcpFile)
      .map((r) => ({ pluginId: r.id, file: r.layout!.mcpFile!, dir: r.dir, data: this.plugins.dataDirOf(r.id), network: r.granted.network, builtin: r.source === "builtin" }));
  }

  /** A sign-in to a plugin's MCP server finished: the chat that showed its card hears it and carries on. */
  mcpSignedIn(source: string, conversationId?: string): void {
    this.bus.emit("connections.updated", { provider: source });
    if (!conversationId || !this.store.getConversation(conversationId)) return;
    const tools = this.tools.list().filter((d) => d.owner.startsWith("mcp:") && this.mcpClients.list().some((s) => s.source === source && `mcp:${s.name}` === d.owner));
    this.runner.tellAgent(
      conversationId,
      `[System] The user signed in to ${source}; it works now${tools.length ? ` and its tools are available: ${tools.map((d) => d.name).join(", ")}` : ""}. Carry on with what it was needed for.`,
    );
  }

  /** Sign-ins to plugins' catalog entries in progress, by entry id ("composio:slack"): the chat that asked for one. */
  private entrySignins = new Map<string, { conversationId: string; at: number }>();

  /** The address that signs one of a plugin's entries in; the chat it came from hears once the plugin reports it works. */
  async entrySignIn(id: string, conversationId?: string): Promise<string> {
    const ref = entryRef(id);
    if (!ref) throw new LocalizedError("connections.notFound", { id }, 404);
    const url = await this.plugins.catalogSignIn(ref.pluginId, ref.entryId);
    if (conversationId && this.store.getConversation(conversationId)) this.entrySignins.set(id, { conversationId, at: Date.now() });
    return url;
  }

  async entrySignOut(id: string): Promise<void> {
    const ref = entryRef(id);
    if (!ref) throw new LocalizedError("connections.notFound", { id }, 404);
    await this.plugins.catalogSignOut(ref.pluginId, ref.entryId);
  }

  /** A plugin reported its entries: the catalogs redraw, and a chat waiting for an entry's sign-in carries on. */
  private catalogUpdated(pluginId: string, before: CatalogEntryState[], after: CatalogEntryState[]): void {
    this.bus.emit("connections.updated", { provider: pluginId });
    const was = new Map(before.map((e) => [e.id, e.status]));
    const layout = this.plugins.get(pluginId)?.layout;
    for (const e of after) {
      if (e.status !== "connected" || was.get(e.id) === "connected") continue;
      const id = `${pluginId}:${e.id}`;
      const waiting = this.entrySignins.get(id);
      this.entrySignins.delete(id);
      if (!waiting || Date.now() - waiting.at > ENTRY_SIGNIN_MS || !this.store.getConversation(waiting.conversationId)) continue;
      const prefix = layout ? `${toolPrefixOf(layout.manifest)}_${e.id.replace(/-/g, "_")}_` : "";
      const tools = prefix ? this.tools.list().filter((d) => d.owner === pluginId && d.name.startsWith(prefix)).map((d) => d.name) : [];
      const name = (layout ? localizePluginValue(layout, layout.manifest.integration?.entries.find((x) => x.id === e.id)?.name, hubLocale()) : undefined) ?? e.name ?? e.id;
      this.runner.tellAgent(
        waiting.conversationId,
        `[System] The user signed in to ${name} (${id}); it works now${tools.length ? ` and its tools are available: ${tools.join(", ")}` : ""}. Carry on with what it was needed for.`,
      );
    }
  }

  /** Approval cards also go to channels (Telegram) with signed buttons. */
  private wireChannelsForApprovals(): void {
    this.bus.on("approval.created", (a) => {
      const s = this.settings.get();
      const agent = this.agents.get(a.agentId);
      const name = agent ? agentName(agent, hubLocale()) : a.agentId;
      const text = s.channelApprovalDetails
        ? `${t("approval.channelAsk", { agent: name, summary: a.summary })}${a.tainted ? `\n\n${t("approval.taintedNote")}` : ""}`
        : `${t("approval.channelAskTool", { agent: name, tool: a.tool })}${a.tainted ? `\n${t("approval.taintedNote")}` : ""}`;
      void this.channels.broadcast({
        kind: "approval",
        text,
        link: `${this.config.consoleUrl}/#/approvals/${a.id}`,
        approval: { id: a.id, summary: a.summary, approveToken: this.approvals.token(a.id, "approve"), denyToken: this.approvals.token(a.id, "deny") },
      });
    });
  }

  /** Where machines reach this hub (/node/ws, /mcp): the link when this hub runs on localhost. */
  machineHubUrl(): string {
    return machineHubUrl(this.config.publicUrl, this.remote.link());
  }

  private started = false;
  private leading = false;

  /** Main-only work: tasks, channels, digests, setup checks, plugins and MCP servers (cluster.ts: on the leader only). */
  async lead(): Promise<void> {
    if (this.leading || this.stopping) return;
    this.leading = true;
    const cfg = this.config;
    // What other replicas wrote meanwhile: settings and agents are read again.
    this.agents.reload();
    this.store.agentConversation(this.settings.get().defaultAgent);
    if (cfg.plugins !== "none") await this.plugins.startAll(cfg.plugins);
    await this.mcpClients.sync(this.pluginMcpFiles());
    this.mcpClients.onChange = () => this.bus.emit("plugins.updated", {});
    this.runner.start();
    this.feeds.start();
    this.setupChats.sweep();
    this.setup.start();
    this.notifier.startDigestTimer();
    for (const m of this.machines.list()) if (m.status === "online") void this.machines.pushSetup(m.id);
    // A new version since the last start: the default agent tells the person what changed.
    void announceUpdate(this).catch((e) => console.log(`[piomio] update note: ${e?.message ?? e}`));
  }

  /**
   * Another replica leads: this one stops its main-only work and keeps its data current. `stale`: that one took the
   * lead while this one slept (cluster.ts), and with it this one's tasks.
   */
  async standby(o: { stale?: boolean } = {}): Promise<void> {
    if (!this.leading) return;
    this.leading = false;
    this.notifier.stop();
    this.feeds.stop();
    this.setup.stop();
    await this.runner.stop();
    // Its tasks go back to the queue: the leader carries them on from where they stopped. One that led while this
    // replica slept queued them when it took over and may have finished them since: this one's older copies queued
    // again would win over that (newest write wins) and run them twice.
    if (!o.stale) for (const t of this.store.listTasks({ status: ["running", "waiting_approval", "interrupted"] })) this.store.updateTask(t.id, { status: "queued" });
    await this.plugins.stopAll();
    await this.mcpClients.closeAll();
    // Machines that reached this replica while it led reconnect, and land on the leader (directly or over the link).
    this.machines.closeAll();
  }

  async start(opts: { listen?: boolean } = {}): Promise<void> {
    const cfg = this.config;
    if (cfg.isolation.users) process.umask(0o002);
    for (const d of ["workspaces", "skills", "commands", "agents", "plugins", "plugins-data", "home"]) mkdirSync(join(cfg.dataDir, d), { recursive: true });
    const passphraseFile = cfg.vaultPassphraseFile ?? (existsSync(this.rememberedPassphraseFile()) ? this.rememberedPassphraseFile() : undefined);
    if (passphraseFile) this.vault.unlockFromFile(passphraseFile);
    this.audit.append("core", "hub.start", cfg.version);

    await this.egress.listen(cfg.egressPort);
    this.plugins.discover();
    this.started = true;

    if (opts.listen !== false) {
      this.mainApp = await buildMainApp(this);
      this.consoleApp = await buildConsoleApp(this);
      await this.mainApp.listen({ host: cfg.host, port: cfg.port });
      await this.consoleApp.listen({ host: cfg.host, port: cfg.consolePort });
      await this.syncDeviceServer();
      await this.remote.start();
    }

    // Desktop installs run from launchd or a tray app; a terminal's `npm start` already has the user's PATH.
    if (cfg.installClis) await this.userPath.refresh();
    await this.cluster.start();
    if (this.cluster.leads()) await this.lead();
    const sweep = setInterval(() => this.auth.sweep(), 3600_000);
    sweep.unref();
    this.timers.push(sweep);
    const prune = setInterval(() => this.media.prune(), 24 * 3600_000);
    prune.unref();
    this.timers.push(prune);

    if (this.auth.setupToken) {
      const line = "═".repeat(64);
      console.log(`\n${line}\n  ${t("cli.firstRun", { url: cfg.publicUrl, code: this.auth.setupToken })}\n${line}\n`);
    } else {
      console.log(`[piomio] ready: ${cfg.publicUrl} (console: ${cfg.consoleUrl})`);
    }
  }

  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    await this.cluster.stop();
    this.notifier.stop();
    this.feeds.stop();
    this.setup.stop();
    await this.runner.stop();
    this.machines.closeAll();
    this.activity.close();
    await this.plugins.stopAll();
    await this.mcpClients.closeAll();
    await this.remote.stop();
    await this.mainApp?.close();
    await this.consoleApp?.close();
    await this.deviceSync;
    await this.deviceApp?.close();
    await this.egress.close();
    this.audit.append("core", "hub.stop");
    this.db.close();
    this.vault.db.close();
  }
}

export type { CoreMethod };
