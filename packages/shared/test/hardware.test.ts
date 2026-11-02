import { describe, expect, it } from "vitest";
import { parseGpus } from "../src/hardware.ts";

describe("graphics cards by name", () => {
  it("reads macOS's system_profiler, with the GPU cores", () => {
    const json = JSON.stringify({ SPDisplaysDataType: [{ _name: "Apple M4 Pro", sppci_model: "Apple M4 Pro", sppci_cores: "20", spdisplays_ndrvs: [{ _name: "Color LCD" }] }] });
    expect(parseGpus("macos", json)).toEqual(["Apple M4 Pro, 20 cores"]);
    expect(parseGpus("macos", "not json")).toEqual([]);
  });

  it("reads Windows' video controllers, without the virtual ones", () => {
    expect(parseGpus("windows", "NVIDIA GeForce RTX 4070\r\nMicrosoft Basic Display Adapter\r\nParsec Virtual Display Adapter\r\n")).toEqual(["NVIDIA GeForce RTX 4070"]);
  });

  it("reads nvidia-smi with the memory, each card once", () => {
    expect(parseGpus("nvidia-smi", "NVIDIA GeForce RTX 4090, 24564 MiB\nNVIDIA GeForce RTX 4090, 24564 MiB\n")).toEqual(["NVIDIA GeForce RTX 4090, 24 GB"]);
    expect(parseGpus("nvidia-smi", "")).toEqual([]);
  });

  it("reads lspci's display controllers, not a virtual server's emulated one", () => {
    const out = [
      "00:00.0 Host bridge: Intel Corporation 440FX - 82441FX PMC [Natoma] (rev 02)",
      "00:01.0 VGA compatible controller: Device 1234:1111 (rev 02)",
      "01:00.0 VGA compatible controller: NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)",
      "02:00.0 3D controller: NVIDIA Corporation GA100 [A100 PCIe 40GB] (rev a1)",
    ].join("\n");
    expect(parseGpus("lspci", out)).toEqual(["NVIDIA Corporation AD102 [GeForce RTX 4090]", "NVIDIA Corporation GA100 [A100 PCIe 40GB]"]);
  });
});
