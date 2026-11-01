// Piomio hub CLI: start | version | reset-password | pairing-code | devices pair | backup | audit-verify | uninstall

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.ts";
import { hubDbFile, openDb, type Db } from "./db.ts";
import { Settings } from "./settings.ts";
import { tFor } from "./i18n.ts";
import { DEFAULT_LOCALE, localeFromEnv, normalizeLocale, type Translate } from "@piomio/shared";
import { AuditLog } from "./audit.ts";
import { AuthService } from "./auth.ts";
import { Hub } from "./app.ts";
import { readDesktopCommands } from "./desktop-login.ts";
import { EventBus } from "./bus.ts";
import { DeviceRegistry } from "./devices.ts";
import { deviceTls } from "./devices-tls.ts";
import { deviceUrls, hubName, pairingLink, qrText } from "./pairing.ts";
import { joinCluster, localInvite } from "./cluster.ts";
import { InviteRegistry } from "./invites.ts";
import { homedir, hostname } from "node:os";
import { installLayout, settleBeforeStart, TRIAL_MAX_MS } from "./self-update.ts";

const [cmd = "start", ...args] = process.argv.slice(2);
const config = loadConfig();
const dbFile = () => hubDbFile(config.dataDir);

/** CLI messages: the terminal's locale (PIOMIO_LANG, LC_ALL, LANG), else the hub language, else English. */
function cliT(db?: Db): Translate {
  const env = localeFromEnv(process.env);
  if (env) return tFor(env);
  const saved = db ? normalizeLocale(new Settings(db, config.timezone).get().language) : undefined;
  return tFor(saved ?? DEFAULT_LOCALE);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      // A server install (packaging/linux): an update that rolled back puts the database back first; one on trial must
      // come up within TRIAL_MAX_MS, or this start counts as failed.
      const update = config.installRoot ? settleBeforeStart(config.installRoot, config.dataDir, config.version) : {};
      if (update.trial) {
        const trial = installLayout(config.installRoot!).trial;
        setTimeout(() => {
          if (!existsSync(trial)) return;
          console.log(`[piomio] ${config.version} did not come up in ${TRIAL_MAX_MS / 1000} s`);
          process.exit(1);
        }, TRIAL_MAX_MS).unref();
      }
      const hub = new Hub(config);
      hub.startState = update;
      let stopping = false;
      const shutdown = async (sig: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[piomio] ${sig}: stopping…`);
        const force = setTimeout(() => process.exit(1), 15_000);
        force.unref();
        await hub.stop().catch((e) => console.error(e));
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      // Run by the desktop app: its stdin carries `stop` and sign-in tickets; closing it stops the hub.
      if (process.env.PIOMIO_DESKTOP === "1") readDesktopCommands(process.stdin, { stop: () => void shutdown("stop"), ticket: (t) => hub.desktopTickets.add(t) });
      process.on("unhandledRejection", (e) => console.error("[piomio] unhandled rejection:", e));
      await hub.start();
      return;
    }
    case "version":
      // Also what an update runs to make sure a new tree loads (self-update.ts).
      console.log(config.version);
      return;
    case "uninstall": {
      // A server install: the app and the service go, the data stays.
      if (!config.installRoot) throw new Error(cliT()("cli.uninstallNotServer"));
      const systemctl = (...a: string[]) => {
        try {
          execFileSync("systemctl", ["--user", ...a], { stdio: "ignore" });
        } catch {
          /* not running, or no user manager */
        }
      };
      systemctl("disable", "--now", "piomio.service");
      rmSync(join(homedir(), ".config", "systemd", "user", "piomio.service"), { force: true });
      systemctl("daemon-reload");
      rmSync(join(homedir(), ".local", "bin", "piomio"), { force: true });
      rmSync(config.installRoot, { recursive: true, force: true });
      console.log(cliT()("cli.uninstalled", { data: config.dataDir }));
      return;
    }
    case "reset-password": {
      const pass = args[0];
      if (!pass || pass.length < 8) throw new Error("usage: piomio reset-password <new-password (min 8 chars)>");
      const db = openDb(dbFile());
      const auth = new AuthService(db, new AuditLog(db), { rpId: new URL(config.publicUrl).hostname, origins: [config.publicUrl] });
      auth.resetPassword(pass);
      console.log(cliT(db)("cli.passwordChanged"));
      return;
    }
    case "pairing-code": {
      const db = openDb(dbFile());
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      db.prepare("insert into pairing_codes(code, name, expires_at) values (?,?,?)").run(code, args[0] ?? null, new Date(Date.now() + 10 * 60_000).toISOString());
      console.log(cliT(db)("cli.pairingCode", { code, url: config.publicUrl }));
      return;
    }
    case "devices": {
      if (args[0] !== "pair") throw new Error("usage: piomio devices pair");
      // A phone pairs with the running hub's device port; the code lives in the shared database.
      const db = openDb(dbFile());
      const T = cliT(db);
      const { code } = new DeviceRegistry({ db, bus: new EventBus(), audit: new AuditLog(db) }).createPairingCode();
      const link = pairingLink({ code, hubName: hubName(), fingerprint: deviceTls(config.dataDir).fingerprint, urls: deviceUrls(config.devicePort, config.deviceUrls) });
      console.log(`${qrText(link)}\n`);
      console.log(T("cli.devicePair", { link, code }));
      if (config.devicesOff) console.log(`\n${T("cli.devicesOff")}`);
      return;
    }
    case "backup": {
      const target = args[0] ?? join(config.dataDir, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
      mkdirSync(target, { recursive: true });
      for (const f of [dbFile(), join(config.dataDir, "vault.db")]) {
        const db = new DatabaseSync(f);
        db.exec(`vacuum into '${join(target, basename(f)).replaceAll("'", "''")}'`);
        db.close();
      }
      for (const d of ["agents", "skills", "commands", "plugins", "plugins-data"]) {
        try {
          cpSync(join(config.dataDir, d), join(target, d), { recursive: true });
        } catch {
          /* missing dir */
        }
      }
      console.log(cliT()("cli.backupDone", { path: target }));
      return;
    }
    case "replica": {
      // piomio replica invite [--name mac] --url https://… [--node-url …]  |  piomio replica join <link> --name vps --url https://… [--node-url …] [--force]
      const sub = args[0];
      const flag = (k: string) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
      const name = flag("--name")[0] ?? (hostname().split(".")[0] || "hub");
      const urls = flag("--url");
      const nodeUrls = flag("--node-url");
      if (sub === "invite") {
        const db = openDb(dbFile());
        const r = localInvite({
          dataDir: config.dataDir,
          db,
          invites: new InviteRegistry({ db, bus: new EventBus(), audit: new AuditLog(db) }),
          name,
          urls: urls.length ? urls : deviceUrls(config.devicePort, config.deviceUrls),
          nodeUrls,
          fingerprint: deviceTls(config.dataDir).fingerprint,
        });
        console.log(cliT(db)(r.created ? "cli.replicaInviteNew" : "cli.replicaInvite", { link: r.link }));
        return;
      }
      if (sub === "join" && args[1]) {
        if (!urls.length) throw new Error("usage: piomio replica join <link> --name <name> --url https://<this machine>:<device port> [--node-url <url>] [--force]");
        const r = await joinCluster({ dataDir: config.dataDir, link: args[1], name, urls, nodeUrls, force: args.includes("--force") });
        console.log(cliT()("cli.replicaJoined", { id: r.id, dir: config.dataDir }));
        return;
      }
      throw new Error("usage: piomio replica invite|join …");
    }
    case "audit-verify": {
      const db = openDb(dbFile());
      const r = new AuditLog(db).verify();
      console.log(r.ok ? cliT(db)("cli.auditOk", { count: r.count }) : cliT(db)("cli.auditBroken", { seq: r.brokenAt }));
      process.exitCode = r.ok ? 0 : 2;
      return;
    }
    default:
      console.log("usage: piomio [start|version|reset-password <pass>|pairing-code [name]|devices pair|replica invite|join|backup [dir]|audit-verify|uninstall]");
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
