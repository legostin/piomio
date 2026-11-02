// A computer's graphics cards, by name: the hub and each node say which of them can render or train ("a computer with
// a GPU"). Read once, from what the system itself reports; nothing is installed for it.

import { execFile } from "node:child_process";

/** Where the names come from: macOS's system_profiler (JSON), Windows' video controllers, nvidia-smi's CSV, lspci. */
export type GpuSource = "macos" | "windows" | "nvidia-smi" | "lspci";

/** Adapters that draw nothing worth naming: virtual, remote and fallback displays. */
const NOT_A_GPU = /basic (display|render)|remote display|virtual|hyper-v|vmware|virtualbox|qxl|cirrus|bochs|virtio|parsec|citrix|indirect display|^device [0-9a-f]{4}:/i;

/** The cards in `output` from `source`, each once, without virtual adapters. */
export function parseGpus(source: GpuSource, output: string): string[] {
  let names: string[] = [];
  if (source === "macos") {
    try {
      const items = (JSON.parse(output)?.SPDisplaysDataType ?? []) as Array<Record<string, unknown>>;
      names = items.map((i) => {
        const model = String(i.sppci_model ?? i._name ?? "").trim();
        const cores = typeof i.sppci_cores === "string" && /^\d+$/.test(i.sppci_cores) ? `, ${i.sppci_cores} cores` : "";
        return model ? `${model}${cores}` : "";
      });
    } catch {
      names = [];
    }
  } else if (source === "nvidia-smi") {
    // "NVIDIA GeForce RTX 4090, 24564 MiB"
    names = output.split(/\r?\n/).map((l) => {
      const [name, mem] = l.split(",").map((x) => x.trim());
      const gb = /^(\d+)\s*MiB$/i.exec(mem ?? "");
      return name ? `${name}${gb ? `, ${Math.round(Number(gb[1]) / 1024)} GB` : ""}` : "";
    });
  } else if (source === "lspci") {
    // "01:00.0 VGA compatible controller: NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)"
    names = output
      .split(/\r?\n/)
      .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
      .map((l) => l.replace(/^.*?controller:\s*/i, "").replace(/\s*\(rev [0-9a-f]+\)\s*$/i, "").trim());
  } else {
    names = output.split(/\r?\n/).map((l) => l.trim());
  }
  return [...new Set(names.filter((n) => n && !NOT_A_GPU.test(n)))];
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });
}

let cards: Promise<string[]> | undefined;

/** This computer's graphics cards (read once): NVIDIA's own tool first (it knows the memory), then what the system lists. */
export function graphicsCards(): Promise<string[]> {
  cards ??= (async () => {
    try {
      if (process.platform === "darwin") return parseGpus("macos", await run("system_profiler", ["SPDisplaysDataType", "-json"]));
      const nvidia = parseGpus("nvidia-smi", await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]));
      if (nvidia.length) return nvidia;
      if (process.platform === "win32") {
        return parseGpus("windows", await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_VideoController).Name"]));
      }
      if (process.platform === "linux") return parseGpus("lspci", await run("lspci", []));
    } catch {
      /* nothing to say about it */
    }
    return [];
  })();
  return cards;
}
