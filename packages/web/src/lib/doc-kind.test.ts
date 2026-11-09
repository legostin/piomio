// Which files the in-app document viewer shows, and as what (the rest is saved, never opened in a browser tab).
import { describe, expect, it } from "vitest";
import { docKind } from "./gallery";

describe("docKind", () => {
  it("draws Markdown, shows text and code as it is, a PDF in the browser's viewer", () => {
    expect(docKind("text/markdown", "Epic breakdown in big tech.md")).toBe("markdown");
    expect(docKind(undefined, "notes.MD")).toBe("markdown");
    expect(docKind("application/pdf", "report")).toBe("pdf");
    expect(docKind(undefined, "data.csv")).toBe("text");
    expect(docKind("application/json", "x")).toBe("text");
    expect(docKind("text/plain", "readme")).toBe("text");
    expect(docKind(undefined, "main.rs")).toBe("text");
  });

  it("leaves other files to be saved", () => {
    expect(docKind("application/zip", "build.zip")).toBeUndefined();
    expect(docKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "plan.docx")).toBeUndefined();
    expect(docKind(undefined, "noext")).toBeUndefined();
  });
});
