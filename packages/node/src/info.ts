// Machine report for the hub (MachineInfo) and the daemon's one-line log.

import { readFileSync } from "node:fs";
import { arch, hostname, release, version } from "node:os";
import type { MachineInfo } from "@piomio/shared";
import type { Policy } from "./policy.ts";
import { PIOMIO_VERSION, selfFile } from "./version.ts";

export function osName(): string {
  try {
    if (process.platform === "win32") return version() || `Windows ${release()}`;
    if (process.platform === "darwin") return `macOS ${release()}`;
    if (process.platform === "linux") {
      try {
        const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync("/etc/os-release", "utf8"));
        if (m) return m[1];
      } catch {
        /* no os-release */
      }
      return `Linux ${release()}`;
    }
  } catch {
    /* fall through */
  }
  return `${process.platform} ${release()}`;
}

export function machineInfo(policy: Policy, clis: MachineInfo["clis"]): MachineInfo {
  return {
    os: osName(),
    hostname: hostname(),
    arch: arch(),
    nodeVersion: process.version,
    version: PIOMIO_VERSION,
    selfUpdate: !!selfFile(),
    clis,
    allowedDirs: [...policy.allowedDirs],
  };
}

export type Logger = (msg: string) => void;

export function consoleLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  return (msg: string) => {
    const t = new Date();
    const ts = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    write(`[${ts}] ${msg.replace(/[\r\n]+/g, " ")}`);
  };
}

export const silentLogger: Logger = () => {};
