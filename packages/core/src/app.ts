import { VoiceProviders } from "./speech/providers.ts";
// Hub composition root: builds every core service, wires them together, starts/stops servers.

import { wireNetworkApprovals } from "./network-approvals.ts";
import { networkPattern } from "./egress.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDef, CatalogEntryState, Computer, ConnectionAccount, CoreMethod, DeviceNetwork, DevicePairing, GroupChat, Invite, MachineInfo, TaskStatus, ThinkingView } from "@piomio/shared";
import { DEFAULT_LOCALE, catalogLookup, formatBrainRef, localizeValue, normalizeLocale, parseBrainRef, toolPrefixOf } from "@piomio/shared";
import type { Config } from "./config.ts";
import { hubDbFile, openDb, type Db } from "./db.ts";
import { EventBus } from "./bus.ts";
import { Store } from "./store.ts";
import { DEFAULT_BRAIN_EGRESS, Settings, type CoreSettings } from "./settings.ts";
import { VaultService } from "./vault/service.ts";
import { AuditLog } from "./audit.ts";
import { RuleStore } from "./policy/rules.ts";
import { ApprovalService } from "./approvals.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { HookRegistry } from "./hooks.ts";
import { ToolGateway } from "./tools/gateway.ts";
import { AgentRegistry, agentFromMarkdown, agentMoved, agentName, brainMoved } from "./agents.ts";
import { AgentsStateStore } from "./agents-state.ts";
import { GroupsStateStore } from "./groups-state.ts";
import { SkillHolders, SkillIndex } from "./skills.ts";
import { PluginHost } from "./plugins/host.ts";
import { EgressProxy } from "./egress.ts";
import { BrainRegistry } from "./brains.ts";
import { ChannelRegistry } from "./channels.ts";
import { inQuietHours, localHHMM, Notifier } from "./notifier.ts";
import { SessionRunner } from "./runner.ts";
import { Team } from "./team.ts";
import { roadRoute } from "./routing.ts";
import { UserLocations } from "./user-location.ts";
import { announceUpdate } from "./updates.ts";
import { OFFERS_KEY, offerNote, pendingOffers } from "./plugins/offers.ts";
import { clearRolledBack, confirmStarted, HubUpdates, type StartState } from "./self-update.ts";
import { FEED_RUN_TOOLS, Feeds } from "./feeds.ts";
import { SetupChats } from "./setup-chats.ts";
import { registerFeedTools } from "./tools/feed-tools.ts";
import { registerThinkingTools } from "./tools/thinking-tools.ts";
import { thinkingView } from "./thinking.ts";
import { registerPageTools } from "./tools/page-tools.ts";
import { registerGroupTools } from "./tools/group-tools.ts";
import { registerNativePermission } from "./tools/native-permission.ts";
import { ownedWorkspaces, ownsWorkspacePaths } from "@piomio/shared/agent-workspaces";
import { ordinaryFilePaths } from "./access/owned-files.ts";
import { AutoMode, type AutoAction, type AutoContext, type AutoWhere } from "./policy/auto.ts";
import { accessView, buildAccessMap, serviceOf, type AccessMap } from "./access/map.ts";
import { EgressGuard } from "./policy/egress.ts";
import { Pictures } from "./policy/pictures.ts";
import { brainReviewer } from "./policy/reviewer.ts";
import { Pages } from "./pages.ts";
import { readLibrary, type LibraryQuery } from "./library.ts";
import { registerCoreTools } from "./tools/core-tools.ts";
import { McpEndpoint } from "./mcp/server.ts";
import { McpClientManager } from "./mcp/client.ts";
import { AuthService } from "./auth.ts";
import { DesktopTickets } from "./desktop-login.ts";
import { MachineHub } from "./machines.ts";
import { MachineSetups } from "./machine-setup.ts";
import { Cluster } from "./cluster.ts";
import { OwnNode } from "./own-node.ts";
import { MachineActivityFeed } from "./activity.ts";
import { DeviceRegistry } from "./devices.ts";
import { InviteRegistry } from "./invites.ts";
import { deviceTls, type DeviceTls } from "./devices-tls.ts";
import { deviceUrls, inviteUrl, machineHubUrl, pairingLink, qrSvg, serverJoinCommand } from "./pairing.ts";
import { createCoreCall } from "./core-call.ts";
import { CoreTriggers, TRIGGERS_ID } from "./signals/core-host.ts";
import { proxiedGet } from "./signals/net.ts";
import { configureHubLocale, coreCatalog, hubLocale, localizePluginValue, LocalizedError, t } from "./i18n.ts";
import { registerHubTools, slug } from "./tools/hub-tools.ts";
import { SecretIntake } from "./secrets.ts";
import { AgentDrafts } from "./agent-drafts.ts";
import { BrainLogins } from "./brain-login.ts";
import { CliTools } from "./cli-tools.ts";
import { graphicsCards } from "@piomio/shared/hardware";
import { UserPath } from "@piomio/shared/user-path";
import { SetupGuide } from "./setup.ts";
import { MediaService } from "./media.ts";
import { Connections } from "./connections.ts";
import { entryRef, listIntegrations } from "./integrations.ts";
import { cleanTranscription, Transcriber } from "./transcribe.ts";
import { SpeechEngine } from "./speech/engine.ts";
import { cleanVoice } from "./speech/settings.ts";
import { RemoteAccess, remoteStatusFile } from "./remote.ts";
import { HubCommands } from "./commands.ts";
import { buildMainApp } from "./server/main-app.ts";
import { buildConsoleApp } from "./server/console-app.ts";
import { buildDeviceApp } from "./server/device-app.ts";
import { RealtimeSockets } from "./server/realtime.ts";
import { DevicePushes, PushRelay, desktopNotifyLine, messageNote, pushNote, watchAgentMessages } from "./push.ts";
import { pageReader } from "./signals/extract.ts";
import { scriptSandbox } from "./signals/sandbox.ts";
import { quickModel } from "./bare-ask.ts";
import type { FastifyInstance } from "fastify";

/** How long a chat waits to hear about an entry's sign-in it started. */
const ENTRY_SIGNIN_MS = 30 * 60_000;
/** Where earlier versions kept a Claude subscription token (forgetClaudeToken). */
const OLD_CLAUDE_TOKEN = "claude_code_token";

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
  /** Auto mode: a reviewer decides what used to be an approval card (policy/auto.ts). */
  auto: AutoMode;
  /** What a tainted session may open on the web without a review (policy/egress.ts). */
  egressGuard = new EgressGuard();
  /** Which pictures the hub may fetch when a chat shows them (policy/pictures.ts). */
  pictures: Pictures;
  private reviewToken?: string;
  private quickToken?: string;
  agents: AgentRegistry;
  /** Pinned, archived and deleted built-in agents (agents-state.ts). */
  agentsState: AgentsStateStore;
  /** Group chats in the archive (groups-state.ts). */
  groupsState: GroupsStateStore;
  skills = new SkillIndex();
  egress = new EgressProxy();
  brains = new BrainRegistry();
  channels: ChannelRegistry;
  notifier: Notifier;
  runner: SessionRunner;
  /** "/task …", "/brain": the hub's own commands (commands.ts). */
  commands: HubCommands;
  team: Team;
  /** The user's channels: news an agent gathers on a schedule (feeds.ts). */
  feeds: Feeds;
  /** Pages agents make (pages.ts). */
  pages: Pages;
  /** An agent's library (library.ts): the files, pictures and pages of its chats, newest first. */
  library(q: LibraryQuery = {}) {
    return readLibrary({ db: this.db, workspacesRoot: join(this.config.dataDir, "workspaces"), pages: this.pages }, q);
  }
  /** "New channel" and "Add agent" chats (setup-chats.ts). */
  setupChats: SetupChats;
  plugins: PluginHost;
  /** The trigger engine (signals/): runs while this hub leads and the Triggers card is on. */
  triggers: CoreTriggers;
  /** This computer's graphics cards, once read (start()). */
  private gpus?: string[];
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
  /** This computer as a machine of the cluster while another replica leads (own-node.ts). */
  ownNode: OwnNode;
  /** The realtime sockets this replica serves from its own bus: they follow the lead (server/realtime.ts). */
  readonly realtime = new RealtimeSockets();
  /** What every machine is doing now, for the machines block (activity.ts). */
  activity: MachineActivityFeed;
  /** Updates on the person's button: this hub's on a server install, and the machines' (self-update.ts). */
  updates: HubUpdates;
  /** What cli.ts found of an update in progress before the database opened (settleBeforeStart). */
  startState: StartState = {};
  /** Phones paired with the hub (the Piomio app) and the device port they talk to. */
  devices: DeviceRegistry;
  /** Phones' pushes through the push relay (push.ts). */
  pushes: DevicePushes;
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
  /** The local speech engine: voices and speech to text, downloaded on demand (speech/engine.ts). */
  speech: SpeechEngine;
  voiceProviders: VoiceProviders;
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
    this.pictures = new Pictures(this.db, this.egressGuard);
    this.pictures.backfill();
    this.store = new Store(this.db, this.bus);
    // A server's hub (install.sh) opens through its link: access from anywhere starts on, waiting for Tailscale's sign-in.
    this.settings = new Settings(this.db, config.timezone, config.installRoot ? { remoteAccess: true } : {});
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
    this.groupsState = new GroupsStateStore(this.settings);
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
    // The reviewer runs on this computer's own Claude Code, through the egress proxy like any brain.
    this.auto = new AutoMode({
      reviewer: brainReviewer({ brains: this.brains, dataDir: config.dataDir, env: () => this.reviewerEnv(), log: (m) => console.log(m) }),
      context: (w, a) => this.autoContext(w, a),
      dataDir: config.dataDir,
      language: () => this.settings.get().language,
      audit: this.audit,
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
      auto: this.auto,
      machineName: (id) => this.runner.computerName(id),
      egress: this.egressGuard,
      pictures: this.pictures,
      hubOnly: (owner) => !!this.plugins.get(owner)?.layout?.manifest.integration?.localApp,
      // "%key%" approval summaries resolve against the owner's messages in the hub language.
      localize: (owner, text) =>
        owner === "core" ? localizeValue(text, catalogLookup(coreCatalog, hubLocale())) : localizePluginValue(this.plugins.get(owner)?.layout, text, hubLocale()),
    });
    this.invites = new InviteRegistry({ db: this.db, bus: this.bus, audit: this.audit });
    this.setups = new MachineSetups({ db: this.db, bus: this.bus, audit: this.audit, vault: () => this.vault, apiKeys: () => this.config.apiKeys });
    this.machines = new MachineHub({ db: this.db, bus: this.bus, brains: this.brains, audit: this.audit, invites: this.invites, setups: this.setups });
    this.cluster = new Cluster(this);
    this.ownNode = new OwnNode(this);
    this.machines.cluster = this.cluster;
    this.machines.version = config.version;
    this.machines.here = () => ({ id: this.here(), name: this.machines.localName() });
    this.machines.boundTo = (id) => this.agents.get(id)?.machines;
    this.activity = new MachineActivityFeed(this.bus, this.machines);
    this.updates = new HubUpdates({
      config,
      db: this.db,
      bus: this.bus,
      tell: (note) => this.tellDefaultAgent(note),
      // cli.ts stops the hub on SIGTERM; systemd then starts the version `current` points at.
      restart: () => void process.kill(process.pid, "SIGTERM"),
      machine: (id) => {
        const m = this.machines.get(id);
        return m ? { name: m.name, info: m.info, online: m.status === "online" } : undefined;
      },
      sendNode: (id, update) => this.machines.sendUpdate(id, update),
      appUpdateNode: (id) => this.machines.appUpdate(id),
      // Standby replicas behind this hub update themselves when asked over their link (cluster.ts).
      replicas: () => this.cluster.replicaPeers(),
      askReplica: (id, version) => this.cluster.askUpdate(id, version),
    });
    this.activity.updates = this.updates;
    this.bus.on("machine.updated", (m: { id?: string; info?: MachineInfo } | undefined) => m?.id && this.updates.machineChanged(m.id, m.info));
    // The same computer paired again: what named its removed record follows it.
    this.bus.on("machine.replaced", (e: { from: string; to: string }) => this.machineReplaced(e.from, e.to));
    // The intro ends after the hub started leading on a new hub: the plugin offers follow it.
    this.bus.on("settings.updated", (e: { keys?: string[] } | undefined) => {
      if (e?.keys?.includes("setup")) this.offerPlugins();
    });
    this.devices = new DeviceRegistry({ db: this.db, bus: this.bus, audit: this.audit, invites: this.invites });
    this.locations = new UserLocations(this.settings, (id) => !!this.devices.get(id));
    this.pushes = new DevicePushes({ db: this.db, bus: this.bus, ...(config.pushRelay ? { relay: new PushRelay(config.pushRelay) } : {}) });
    // Every agent's message in the person's chats and what the notifier delivers wake their phones (the words stay
    // here) and, on the desktop app's own hub, show as this computer's notifications. The badge counts unread chats.
    this.notifier.onDelivered = (n, o) => {
      void this.pushes.send(n, { silent: o.silent, badge: this.store.unreadChats() });
      if (config.desktopNotify) process.stdout.write(desktopNotifyLine(pushNote(n, o.recipient, this.notifier.agentName), o.silent));
    };
    watchAgentMessages({
      bus: this.bus,
      store: this.store,
      on: (m, c) => {
        // A standby replica hears the leader's messages too: only the leader wakes anyone.
        if (this.cluster && !this.cluster.leads()) return;
        const note = messageNote(m, c, this.notifier.agentName, t("push.file"));
        if (!note) return;
        const s = this.settings.get();
        const silent = inQuietHours(s.quietHours, localHHMM(s.timezone));
        void this.pushes.send(note, { silent, badge: this.store.unreadChats() });
        if (config.desktopNotify) process.stdout.write(desktopNotifyLine(note, silent));
      },
    });
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
    this.speech = new SpeechEngine({
      dataDir: config.dataDir,
      language: () => this.settings.get().language,
      voice: () => this.settings.get().voice,
      sttProvider: () => this.settings.get().transcription?.provider ?? "auto",
      emit: (status) => this.bus.emit("speech.status", this.voiceProviders?.status(status) ?? status),
      log: (line) => console.log(line),
    });
    // Without a key (or with provider "local") voice messages go to the local engine once it is installed.
    this.transcriber.local = this.speech;
    this.bus.on("plugins.updated", () => this.speech.changed());
    this.bus.on("plugin.event", (e: { pluginId?: string }) => { if (e.pluginId === "voice-providers") this.speech.changed(); });
    this.bus.on("settings.updated", (e) => {
      const keys = (e as { keys?: unknown }).keys;
      if (Array.isArray(keys) && keys.some((k) => k === "voice" || k === "transcription" || k === "language")) this.speech.changed();
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
      egressGuard: this.egressGuard,
      pictures: this.pictures,
      approvals: this.approvals,
      egress: this.egress,
      claudePluginDirs: () => this.plugins.enabledLayouts().filter((l) => l.formats.includes("claude") && !l.manifest.builtin).map((l) => l.dir),
      machineName: (id) => this.machines.name(id) ?? this.replicaName(id),
      machines: () => this.machines.list(),
      canonicalMachine: (id) => this.machines.canonical(id),
      groupArchived: (id) => this.groupsState.isArchived(id),
      here: () => this.here(),
      gpus: () => this.gpus,
      // The kinds of brain that can be here at all: the brain plugins' and the computers' (a missing one may come back).
      brainKinds: () => [
        ...this.plugins.enabledLayouts().flatMap((l) => l.manifest.contributes.brains),
        ...this.machines.list().flatMap((m) => m.info?.clis.map((c) => c.brainId) ?? []),
      ],
      activity: this.activity,
      locations: this.locations,
      signalNotes: (q) => this.triggers.notes(q),
      secrets: this.secrets,
      transcriber: this.transcriber,
      toolNames: () =>
        this.tools
          .list()
          .map((t) => t.name)
          .join(","),
    });
    this.setup = new SetupGuide({
      apiKeys: this.config.apiKeys,
      brains: this.brains,
      agents: this.agents,
      settings: this.settings,
      store: this.store,
      vault: this.vault,
      channels: this.channels,
      machines: this.machines,
      remote: () => {
        const v = this.remote.view();
        return { on: v.available && v.enabled, up: v.state === "running" };
      },
      cliTools: this.cliTools,
      bus: this.bus,
      isRunning: (id) => this.runner.isRunning(id),
      resume: (id, prompt, opts) => this.runner.resume(id, prompt, opts),
      tellAgent: (id, note) => this.runner.tellAgent(id, note),
    });
    this.runner.d.setup = this.setup;
    this.commands = new HubCommands({
      store: this.store,
      agents: this.agents,
      channels: this.channels,
      publicUrl: config.publicUrl,
      thinkingView: (a) => this.thinkingView(a),
      saveAgent: (a, actor) => this.saveAgent(a, actor),
      tasks: this.runner,
    });
    this.runner.d.commands = this.commands;
    this.team = new Team({
      store: this.store,
      agents: this.agents,
      pinned: () => this.agentsState.get().pinned,
      bus: this.bus,
      isRunning: (id) => this.runner.isRunning(id),
      floor: (id) => this.runner.floor(id),
      archived: (id) => this.groupsState.isArchived(id),
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
    const coreCall = createCoreCall(this);
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
      coreCall,
      onLayoutsChanged: () => this.reindex(),
      // The user's own CLIs first, then the ones the hub installed: a CLI the user installed wins.
      cliBinDirs: () => [...this.userPath.dirs(), ...this.cliTools.binDirs()],
      attachPart: (conversationId, part) => this.runner.attachPart(conversationId, part),
      onCatalogUpdated: (pluginId, before, after) => this.catalogUpdated(pluginId, before, after),
    });
    this.triggers = new CoreTriggers({
      db: this.db,
      bus: this.bus,
      tools: this.tools,
      card: {
        get: () => {
          const r = this.plugins.get(TRIGGERS_ID);
          const allowed = config.plugins === "all" || (Array.isArray(config.plugins) && config.plugins.includes(TRIGGERS_ID));
          return r && allowed ? { enabled: r.enabled, settings: r.settings } : undefined;
        },
        onSettings: (cb) => this.plugins.onSettings(TRIGGERS_ID, cb),
      },
      coreCall,
      hubUrl: config.internalUrl,
      // Page loads go through the egress proxy, checked and audited like the plugin process's were: a token per start,
      // revoked with its connections when the engine stops (as the plugin's went with its process).
      fetch: () => {
        const token = this.egress.issueToken("plugin:triggers", ["*"]);
        const get = proxiedGet(`http://${token}:x@127.0.0.1:${config.egressPort}`);
        return {
          fetch: get,
          release: () => {
            this.egress.revoke(token);
            get.close();
          },
        };
      },
      // Triggers' scripts read with their agents' tools; triage and pio.llm.ask ask the quick model; a script's fetches
      // go through the egress proxy on a token of each run's own.
      gateway: this.gateway,
      quick: quickModel({ brains: this.brains, dataDir: config.dataDir, env: () => this.quickEnv() }),
      egress: { proxy: this.egress, port: config.egressPort },
      vault: this.vault,
    });
    // The person turned the Triggers card on or off.
    this.bus.on("plugins.updated", () => {
      if (this.leading && !this.stopping) void this.triggers.sync().catch((e) => console.log(`[piomio] triggers: ${e?.message ?? e}`));
    });
    this.voiceProviders = new VoiceProviders(this.plugins, this.speech, this.transcriber);
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
      ...(config.tailnetLinkCheck ? {} : { checkLink: async () => true }),
      ...(config.installRoot ? { statusFile: remoteStatusFile(config.dataDir) } : {}),
    });
    // The link is one of the phones' addresses: the Devices page follows it. The chat that showed its card hears it is up.
    let linkUp = false;
    this.bus.on("remote.updated", (v) => {
      this.bus.emit("devices.network", this.deviceNetwork());
      const was = linkUp;
      linkUp = v.state === "running" && !!v.url;
      if (linkUp && !was) this.linkCameUp(v.url!);
    });
    registerCoreTools({
      registry: this.tools,
      skills: this.skills,
      vault: this.vault,
      store: this.store,
      notifier: this.notifier,
      agents: this.agents,
      createTask: (t) => this.runner.createTask(t),
      rules: this.runner.rules,
      tasks: {
        place: (agentId, machine) => this.runner.placeTask(agentId, machine),
        ask: (taskId, question) => this.runner.askStarter(taskId, question),
        goal: (taskId, status, summary) => this.runner.reportGoal(taskId, status, summary),
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
      library: (q) => this.library(q),
    });
    this.machines.registerTools(this.tools);
    registerHubTools(this);
    wireNetworkApprovals({
      egress: this.egress, approvals: this.approvals, settings: this.settings, store: this.store, audit: this.audit, agents: this.agents,
      note: (r, message) => this.runner.networkDenied(r.sessionId, r.conversationId, message),
      auto: this.auto,
      workspaceFor: (r) => this.runner.workspacePath(r),
      machine: () => this.runner.computerName("local"),
    });
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
    registerGroupTools({
      registry: this.tools,
      store: this.store,
      agents: this.agents,
      archive: (id, archived, opts) => this.archiveGroup(id, archived, "agent", opts),
      remove: (id, opts) => this.deleteGroup(id, "agent", opts),
      approvals: this.approvals,
      approvalWaitMs: () => Math.max(120_000, this.settings.get().approvalInlineWaitSec * 1000),
    });
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
      here: () => this.here(),
      auto: this.auto,
      ownedFolders: (ctx) => this.machines.canonical(ctx.machineId ?? "local") === this.here() ? ownedWorkspaces(this.workspaceRoots(), ctx.agentId, this.workspaceKeys(ctx.agentId)) : [],
      ownedFiles: (action, ctx) => this.ownsFiles(action, ctx),
      machineName: (id) => this.runner.computerName(id),
      egress: this.egressGuard,
      given: (s) => this.gateway.egressGiven(s),
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
    if ("brainEgressAllow" in p) {
      try {
        if (!Array.isArray(p.brainEgressAllow) || p.brainEgressAllow.length > 500 || !p.brainEgressAllow.every((v) => typeof v === "string")) throw new Error();
        p.brainEgressAllow = [...new Set(p.brainEgressAllow.map(networkPattern))];
      } catch { throw new LocalizedError("network.badList", undefined, 400); }
    }
    if ("language" in p) {
      const l = normalizeLocale(p.language);
      if (!l) throw new LocalizedError("settings.badLanguage", { value: String(p.language) }, 400);
      p.language = l;
    }
    if ("defaultAgent" in p && !this.agents.get(String(p.defaultAgent))) throw new LocalizedError("agent.notFound", undefined, 400);
    if ("defaultAgent" in p && this.agents.isArchived(String(p.defaultAgent))) throw new LocalizedError("agent.archivedDefault", undefined, 400);
    if ("defaultAgent" in p && this.agents.get(String(p.defaultAgent))?.companion) throw new LocalizedError("agent.companionDefault", undefined, 400);
    if ("transcription" in p) {
      const t = cleanTranscription(p.transcription);
      if (typeof t === "string") throw new LocalizedError("settings.badTranscription", { reason: t }, 400);
      p.transcription = t;
    }
    if ("voice" in p) {
      const v = cleanVoice(p.voice, this.speech.sources.voices);
      if (typeof v === "string") throw new LocalizedError("settings.badVoice", { reason: v }, 400);
      p.voice = v;
    }
    const before = this.settings.get().language;
    this.audit.append(actor, "settings.update", undefined, { keys: Object.keys(p) });
    const next = this.settings.update(p as Partial<CoreSettings>);
    if ("brainEgressAllow" in p) this.audit.append(actor, "egress.allow.update", undefined, { hosts: next.brainEgressAllow });
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
    return urls.length ? pairingLink({ code, hubName: this.machines.localName(), fingerprint: this.deviceTls().fingerprint, urls }) : undefined;
  }

  /** One invite for any device: the shareable /join link and, while phones can reach the hub, the phone's QR. */
  createInvite(): Invite {
    const { code, expiresAt } = this.invites.create();
    const url = inviteUrl(machineHubUrl(this.config.publicUrl, this.remote.link()), code);
    const phoneLink = this.phoneLink(code);
    return { code, expiresAt, ...(url ? { url, serverCommand: serverJoinCommand(url) } : {}), ...(phoneLink ? { phoneLink, qrSvg: qrSvg(phoneLink) } : {}) };
  }

  /** A one-time code and the QR for a phone; the device port or the link must be up. */
  devicePairing(): DevicePairing {
    const network = this.deviceNetwork();
    if (!network.listening && !this.remote.deviceLink()) throw new LocalizedError("device.networkOff", undefined, 409);
    const urls = this.phoneUrls();
    if (!urls.length) throw new LocalizedError("device.noAddress", undefined, 409);
    const { fingerprint } = this.deviceTls();
    const { code, expiresAt } = this.devices.createPairingCode();
    const link = pairingLink({ code, hubName: this.machines.localName(), fingerprint, urls });
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

  /** Where "unlock automatically after restarts" keeps the vault passphrase (a file only the hub reads). */
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
    return thinkingView(this.brains, this.db, agent, this.here(), (id) => this.machines.canonical(id));
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

  /**
   * A removed machine record's computer paired again as `to` (machines.ts successor): the agents' brains and computers,
   * the tasks not finished yet and the team's rules that named `from` go to `to`.
   */
  machineReplaced(from: string, to: string): void {
    let agents = 0;
    for (const a of this.agents.all()) {
      const moved = agentMoved(a, from, to);
      if (!moved) continue;
      this.saveAgent(moved, "core");
      agents++;
    }
    const open: TaskStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "interrupted", "paused"];
    let tasks = 0;
    for (const t of this.store.listTasks({ status: open, limit: 10_000 })) {
      const brainRef = t.brainRef && brainMoved(t.brainRef, from, to);
      const machineId = t.machineId === from ? to : t.machineId;
      if (brainRef === t.brainRef && machineId === t.machineId) continue;
      this.store.updateTask(t.id, { brainRef, machineId });
      tasks++;
    }
    let rules = 0;
    for (const r of this.runner.rules.list()) {
      const brain = r.brain && brainMoved(r.brain, from, to);
      if (r.machine !== from && brain === r.brain) continue;
      this.runner.rules.set({ ...r, machine: r.machine === from ? to : r.machine, brain });
      rules++;
    }
    if (agents || tasks || rules) this.audit.append("core", "machine.replaced", to, { from, agents, tasks, rules });
  }

  /** The reviewer's environment: the egress proxy with the brains' hosts, as for a brain session (runner.ts). */
  private reviewerEnv(): Record<string, string> {
    this.reviewToken ??= this.egress.issueToken("brain:auto-review", DEFAULT_BRAIN_EGRESS);
    return this.proxyEnv(this.reviewToken);
  }

  /** The quick model's environment (triggers' triage and pio.llm.ask): the egress proxy with the brains' hosts. */
  private quickEnv(): Record<string, string> {
    this.quickToken ??= this.egress.issueToken("brain:quick", DEFAULT_BRAIN_EGRESS);
    return this.proxyEnv(this.quickToken);
  }

  private proxyEnv(token: string): Record<string, string> {
    const proxy = `http://${token}:x@127.0.0.1:${this.config.egressPort}`;
    return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" };
  }

  /**
   * What auto mode's reviewer reads besides the action: the person's own recent words where the session works, the
   * task's goal, and the agent's earlier calls there (never their results).
   */
  private async autoContext(w: AutoWhere, action?: AutoAction): Promise<AutoContext> {
    const person = this.gateway.personWords({ conversationId: w.conversationId, taskId: w.taskId }).texts;
    const goal = w.taskId ? this.store.getTask(w.taskId)?.goal : undefined;
    const calls = this.store
      .listMessages(w.conversationId, { limit: 40 })
      .filter((m) => m.role === "assistant" && (!m.agentId || m.agentId === w.agentId))
      .flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_call" ? [{ name: p.name, input: this.vault.redactor.value(p.input) }] : [])));
    // The agent's access: a review never fails for want of it.
    const access = await this.accessMap(w.agentId, w.sessionId).then((m) => accessView(m, { reviewer: true }), () => undefined);
    const ownedFiles = action ? await this.ownsFiles(action, w) : false;
    const ownedFileOperation = ownedFiles || (action ? await this.ownsFiles(action, w, true) : false);
    return { person, ownedFiles, ownedFileOperation, ...(goal ? { goal } : {}), calls: calls.slice(-20), ...(access ? { access } : {}) };
  }

  private workspaceRoots(): string[] {
    return [join(this.config.dataDir, "workspaces"), ...this.machines.list().filter((m) => m.sameHost).flatMap((m) => m.info?.workspacesRoot ? [m.info.workspacesRoot] : [])];
  }

  private workspaceKeys(agentId: string): string[] {
    const dialogs = this.db.prepare("select id, task_id from conversations where agent_id = ?").all(agentId) as { id: string; task_id: string | null }[];
    const tasks = this.db.prepare("select id, feed_id from tasks where agent_id = ?").all(agentId) as { id: string; feed_id: string | null }[];
    return [...dialogs.map((r) => r.task_id ?? r.id), ...tasks.map((r) => r.feed_id ? `feed-${r.feed_id}` : r.id)];
  }

  /** Ownership comes from task/dialog rows, never from a path or the requesting agent's prose. */
  private async ownsFiles(action: AutoAction, where: { agentId: string; workspace: string; machineId?: string }, allowCompound = false): Promise<boolean> {
    const files = ordinaryFilePaths(action, where.workspace);
    if (!files || (files.review && !allowCompound)) return false;
    const input = (action.input ?? {}) as Record<string, unknown>;
    const target = typeof input.machine === "string" ? this.machines.find(input.machine)?.id ?? (this.resolveComputer(input.machine) === this.here() ? "local" : undefined) : where.machineId ?? "local";
    if (!target) return false;
    if ((action.kind === "command" || action.tool === "machine_exec") && /win(?:dows|32|_nt)/i.test(this.machines.get(target)?.info?.os ?? "")) return false;
    const agent = this.agents.get(where.agentId);
    if (!agent || (agent.machines?.length && !agent.machines.some((id) => this.machines.canonical(id) === this.machines.canonical(target)))) return false;
    const keys = this.workspaceKeys(where.agentId);
    if (this.machines.canonical(target) !== this.here()) return this.machines.ownsFiles(target, where.agentId, keys, files);
    return ownsWorkspacePaths(this.workspaceRoots(), where.agentId, keys, files.paths, files.copies);
  }

  /**
   * What an agent can reach (access/map.ts): its computers and folders, the internet through the proxy, the services
   * the person connected and how each is now. With a session: that session's own folder too.
   */
  async accessMap(agentId: string, sessionId?: string): Promise<AccessMap> {
    const agent = this.agents.get(agentId);
    const here = this.here();
    const computers = this.computers().map((c) => ({ ...c, ...(c.id !== here ? { commands: this.machines.get(c.id)?.info?.commands } : {}) }));
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    const servers = this.mcpClients.list();
    const services = (await listIntegrations(this, "en")).flatMap((v) => serviceOf(v, servers) ?? []);
    return buildAccessMap({
      agent: { id: agentId, name: agent ? agentName(agent, "en") : agentId, machines: agent?.machines, folders: agent?.folders },
      here,
      computers,
      ...(session ? { ownFolder: this.runner.workspacePath(session) } : {}),
      builtInHosts: DEFAULT_BRAIN_EGRESS,
      addedHosts: this.settings.get().brainEgressAllow,
      services,
    });
  }

  /** The id an agent's binding (AgentDef.machines) names this hub's computer by: its replica id in a cluster, else "local". */
  here(): string {
    return this.cluster.identity?.id ?? "local";
  }

  /**
   * Another replica's computer by name (the replicas table travels to every replica): its serving machine's, as the
   * computers list shows it (own-node.ts), else the replica's own.
   */
  private replicaName(id: string): string | undefined {
    const r = this.db
      .prepare("select r.name, m.name as machine from replicas r left join machines m on m.id = r.machine_id and m.revoked = 0 where r.id = ? and r.revoked = 0")
      .get(id) as { name: string; machine: string | null } | undefined;
    return r ? (r.machine ?? r.name) : undefined;
  }

  /**
   * The computers an agent may be bound to: this hub's own first, the paired machines, then the hub's other replicas.
   * A replica's computer is served by its machine while this one leads (own-node.ts: replicas.machine_id), under the
   * replica's id whoever leads; one without such a machine is on standby: nothing runs there while this one leads.
   */
  computers(): Computer[] {
    const here = this.here();
    const replicas = this.db.prepare("select id, name, machine_id from replicas where revoked = 0 order by priority").all() as Array<{ id: string; name: string; machine_id: string | null }>;
    const served = new Set(replicas.flatMap((r) => (r.machine_id ? [r.machine_id] : [])));
    const machines = this.machines.list().filter((m) => !m.sameHost);
    const ownMachine = replicas.find((r) => r.id === here)?.machine_id;
    return [
      { id: here, aliases: [...new Set([...this.machines.aliases(), ...(ownMachine ? [ownMachine] : [])])], name: this.machines.localName(), online: true },
      ...machines.filter((m) => !served.has(m.id)).map((m) => ({ id: m.id, name: m.name, online: m.status === "online" })),
      ...replicas
        .filter((r) => r.id !== here)
        .map((r) => {
          const m = r.machine_id ? machines.find((x) => x.id === r.machine_id) : undefined;
          return m ? { id: r.id, aliases: [m.id], name: m.name, online: m.status === "online" } : { id: r.id, name: r.name, online: false, standby: true };
        }),
    ];
  }

  /** A computer by id or name ("local" is this hub's), as an agent's binding keeps it; undefined when there is none. */
  resolveComputer(idOrName: string): string | undefined {
    const key = idOrName.trim().toLowerCase();
    if (!key) return undefined;
    if (key === "local") return this.here();
    const executor = this.machines.find(idOrName);
    if (executor?.sameHost) return this.here();
    const list = this.computers();
    return (list.find((c) => c.id.toLowerCase() === key || c.aliases?.some((a) => a.toLowerCase() === key)) ?? list.find((c) => c.name.toLowerCase() === key))?.id;
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

  /** A group chat by its conversation id. */
  private group(id: string) {
    const conv = this.store.getConversation(id);
    if (conv?.kind !== "group") throw new LocalizedError("group.notFound", undefined, 404);
    return conv;
  }

  /**
   * The archive: the group chat sleeps (groups-state.ts). Out of the Groups list, its round and the tasks started there
   * stop and nobody writes in it; its conversation stays, and it comes back as it was.
   */
  archiveGroup(id: string, archived: boolean, actor: string, opts: { fromTurn?: boolean } = {}): GroupChat {
    const conv = this.group(id);
    this.groupsState.set(id, archived);
    if (archived) this.runner.stopGroup(id, { keepTurn: opts.fromTurn });
    this.audit.append(actor, archived ? "group.archive" : "group.restore", id, { title: conv.title });
    const g = this.team.groupOf(conv);
    this.bus.emit("group.updated", g);
    return g;
  }

  /**
   * The group chat goes for good with its conversation: messages, the tasks started there with their threads,
   * notifications. Asked for by a member in its turn there (`fromTurn`), it goes once that turn has ended.
   */
  deleteGroup(id: string, actor: string, opts: { fromTurn?: boolean } = {}): void {
    const conv = this.group(id);
    if (opts.fromTurn) {
      this.runner.stopGroup(id, { keepTurn: true });
      this.runner.afterTurns(id, () => {
        if (this.store.getConversation(id)?.kind === "group") this.deleteGroup(id, actor);
      });
      return;
    }
    const unread = this.notifier.unreadCount();
    this.runner.stopGroup(id, { close: true });
    this.store.deleteGroupData(id);
    this.groupsState.set(id, false);
    this.audit.append(actor, "group.delete", id, { title: conv.title });
    this.bus.emit("group.deleted", { conversationId: id });
    this.notifier.inboxChanged(unread);
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
    const before = this.agents.list().map((a) => a.id).join(",");
    this.agents.reload();
    // A plugin turned on or off brought or took its agents (Pio): the team list follows.
    if (this.started && this.agents.list().map((a) => a.id).join(",") !== before) this.bus.emit("agents.updated", {});
    if (this.started) {
      void this.mcpClients.sync(this.pluginMcpFiles());
    }
  }

  private pluginMcpFiles() {
    return (this.plugins?.list() ?? [])
      .filter((r) => r.enabled && r.layout?.mcpFile)
      .map((r) => ({ pluginId: r.id, file: r.layout!.mcpFile!, dir: r.dir, data: this.plugins.dataDirOf(r.id), network: r.granted.network, builtin: r.source === "builtin" }));
  }

  /** The chat that showed access from anywhere's card, waiting for its link. */
  private linkAsked?: { conversationId: string; at: number };

  remoteCardShown(conversationId: string): void {
    if (this.store.getConversation(conversationId)) this.linkAsked = { conversationId, at: Date.now() };
  }

  private linkCameUp(url: string): void {
    const asked = this.linkAsked;
    this.linkAsked = undefined;
    if (!asked || Date.now() - asked.at > ENTRY_SIGNIN_MS || !this.store.getConversation(asked.conversationId)) return;
    this.runner.tellAgent(
      asked.conversationId,
      `[System] Access from anywhere works now: the link is ${url} (the card shows it with a QR code). Through it the person signs in with their Piomio password. Carry on with what it was needed for.`,
    );
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
    // Computers paired again while this hub did not lead, or before it moved what named their removed records.
    for (const r of this.machines.replaced()) this.machineReplaced(r.from, r.to);
    this.store.agentConversation(this.settings.get().defaultAgent);
    if (cfg.plugins !== "none") await this.plugins.startAll(cfg.plugins);
    await this.triggers.start().catch((e) => console.log(`[piomio] triggers did not start: ${e?.message ?? e}`));
    await this.mcpClients.sync(this.pluginMcpFiles());
    this.mcpClients.onChange = () => this.bus.emit("plugins.updated", {});
    this.runner.start();
    this.feeds.start();
    this.setupChats.sweep();
    this.setup.start();
    this.notifier.startDigestTimer();
    this.forgetClaudeToken();
    for (const m of this.machines.list()) if (m.status === "online") void this.machines.pushSetup(m.id);
    // A new version since the last start: the default agent tells the person what changed, then offers what came new.
    void announceUpdate(this)
      .catch((e) => console.log(`[piomio] update note: ${e?.message ?? e}`))
      .finally(() => this.offerPlugins());
  }

  /**
   * Built-in plugins that ship off with an offer (Pio): the default agent puts them to the person once, after the
   * intro. The ids offered are the leader's to write; ids of what was offered now.
   */
  offerPlugins(): string[] {
    if (!this.leading || this.stopping || this.setup.firstRun() || this.setup.introLeft().length) return [];
    const offered = this.settings.getKey<string[]>(OFFERS_KEY, []);
    const due = pendingOffers(this.plugins.list(), Array.isArray(offered) ? offered : []);
    if (!due.length) return [];
    this.settings.setKey(OFFERS_KEY, [...offered, ...due.map((o) => o.id)]);
    this.tellDefaultAgent(offerNote(due));
    return due.map((o) => o.id);
  }

  /**
   * A Claude subscription token an earlier version kept (vault://claude_code_token, from `claude setup-token`):
   * Anthropic's terms don't let an app store one, so it is deleted once and the person told. Claude Code signs in on
   * each computer itself. The leader does it; the deletion replicates.
   */
  forgetClaudeToken(): boolean {
    if (!this.vault.getMeta(OLD_CLAUDE_TOKEN)) return false;
    this.vault.remove(OLD_CLAUDE_TOKEN);
    this.audit.append("core", "vault.remove", OLD_CLAUDE_TOKEN, { reason: "subscription tokens are not kept" });
    void this.notifier.notify({ level: "notify", title: t("claudeToken.removedTitle"), body: t("claudeToken.removedBody") }).catch(() => {});
    return true;
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
    this.triggers.stop();
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
    // So do the phones and windows: this replica's bus has nothing more to tell them.
    this.realtime.closeAll();
  }

  async start(opts: { listen?: boolean } = {}): Promise<void> {
    const cfg = this.config;
    for (const d of ["workspaces", "skills", "commands", "agents", "plugins", "plugins-data", "home"]) mkdirSync(join(cfg.dataDir, d), { recursive: true });
    const passphraseFile = cfg.vaultPassphraseFile ?? (existsSync(this.rememberedPassphraseFile()) ? this.rememberedPassphraseFile() : undefined);
    if (passphraseFile) this.vault.unlockFromFile(passphraseFile);
    this.audit.append("core", "hub.start", cfg.version);

    await this.egress.listen(cfg.egressPort);
    this.plugins.discover();
    this.started = true;
    // The hub's own graphics cards, for "a computer with a GPU" (read once, in the background).
    void graphicsCards().then((g) => (this.gpus = g));

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
    if (cfg.installRoot) this.settleUpdate(cfg.installRoot);
    this.updates.start();
    // No brain works yet: the CLIs are looked for again, so one signed in over SSH is found without "Check again".
    const recheck = setInterval(() => void this.recheckBrains(), 30_000);
    recheck.unref();
    this.timers.push(recheck);
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

  /** A note to the default agent, which tells the person; only the replica that leads talks. */
  private tellDefaultAgent(note: string): void {
    if (!this.leading) return;
    this.runner.tellAgent(this.store.agentConversation(this.settings.get().defaultAgent).id, note);
  }

  /** The new version is up, so its update stays; or the launcher went back to this one, which the person hears. */
  private settleUpdate(root: string): void {
    if (this.startState.trial) confirmStarted(root, this.config.version);
    const back = this.startState.rolledBack;
    if (back) this.updates.rolledBack(back.to);
    if (back && this.leading) {
      this.tellDefaultAgent(
        `[System] The update to Piomio ${back.to} did not start, so the server went back to ${back.from} by itself; everything is as it was before the update. ` +
          "Tell the person in one short message. The server's log: `journalctl --user -u piomio`.",
      );
      clearRolledBack(root);
    }
  }

  private async recheckBrains(): Promise<void> {
    if (!this.leading || (await this.setup.usable().catch(() => true))) return;
    await this.refreshBrains().catch(() => {});
  }

  private stopping = false;

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.updates.stop();
    await this.cluster.stop();
    await this.ownNode.stop();
    this.notifier.stop();
    this.feeds.stop();
    this.triggers.stop();
    this.setup.stop();
    await this.runner.stop();
    this.speech.stop();
    this.media.previews.stop();
    pageReader.stop();
    scriptSandbox.stop();
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
