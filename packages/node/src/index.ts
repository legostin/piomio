// piomio-node: connects this computer to an Piomio hub (brains on local subscriptions, files, commands).

export { nodeHome, loadConfig, loadKey, savePaired, normalizeHubUrl, nodeWsUrl, NotPairedError, type NodeConfig, type NodeKey } from "./home.ts";
export { generateKey, signChallenge, publicKeyOf, NODE_AUTH_PREFIX } from "./keys.ts";
export { PolicyStore, defaultPolicy, normalizePolicy, policySummary, DEFAULT_NODE_CLAUDE_TOOLS, type Policy } from "./policy.ts";
export { resolveAllowedPath, resolveWorkspace, isInside, PathDenied } from "./guard.ts";
export { execRun, runShell, checkCommand, checkEnv, killTree, ExecDenied, MAX_OUTPUT_BYTES } from "./exec.ts";
export { fsRead, fsWrite, fsList, FsDenied } from "./fsops.ts";
export { BrainHost, resolveCli, shimTarget, defaultBridgeCommand, BRAIN_IDS } from "./brains.ts";
export { NodeService } from "./service.ts";
export { NodeClient, CLOSE_UNAUTHORIZED } from "./client.ts";
export { pair, PairError } from "./pair.ts";
export { createNodeDaemon, type NodeDaemon, type NodeDaemonOptions } from "./daemon.ts";
export { machineInfo, osName, consoleLogger, silentLogger, type Logger } from "./info.ts";
