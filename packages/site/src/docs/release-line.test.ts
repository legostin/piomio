import { describe, expect, it } from "vitest";
import { loadDocs } from "../../scripts/docs.mjs";

describe("the published documentation version", () => {
  it("follows a published minor or major tag instead of main's stale package version", () => {
    const lines = loadDocs({ languages: ["en", "ru"], release: "1.0.3" });
    expect(lines[0]).toMatchObject({ id: "1.0", release: "1.0.3", current: true });
  });
  it("can still build offline without release metadata", () => {
    expect(loadDocs({ languages: ["en"], release: undefined })[0].release).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
