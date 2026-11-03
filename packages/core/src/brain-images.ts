// Native brain output reaches the hub as bytes, even when the brain's private files cannot be read by an agent.
// Only the saved workspace reference enters chat history; the existing authenticated /api/files route serves it.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BRAIN_IMAGE_CHUNK_CHARS, MAX_BRAIN_IMAGE_BASE64, MAX_BRAIN_IMAGE_BYTES, type BrainEvent } from "@piomio/shared";

type ImageEvent = Extract<BrainEvent, { type: "image" }>;
type Pending = { total: number; chunks: string[]; length: number };
const invalid = () => new Error("Generated image data is invalid or incomplete; it was not shown.");

/** One turn's bounded image assembly; discarded when the turn ends or its connection breaks. */
export class BrainImages {
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private length = 0;

  push(e: ImageEvent): { data: Buffer; ext: string } | undefined {
    if (typeof e.id !== "string" || !e.id || e.id.length > 200 || typeof e.data !== "string") throw invalid();
    if (this.seen.has(e.id)) return undefined;
    const index = e.chunk?.index ?? 0;
    const total = e.chunk?.total ?? 1;
    if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total || total > Math.ceil(MAX_BRAIN_IMAGE_BASE64 / BRAIN_IMAGE_CHUNK_CHARS)) throw invalid();
    if (e.data.length > (e.chunk ? BRAIN_IMAGE_CHUNK_CHARS : MAX_BRAIN_IMAGE_BASE64) || this.length + e.data.length > MAX_BRAIN_IMAGE_BASE64) throw invalid();
    let p = this.pending.get(e.id);
    if (!p) {
      if (index !== 0 || this.pending.size + this.seen.size >= 10) throw invalid();
      p = { total, chunks: [], length: 0 };
      this.pending.set(e.id, p);
    }
    if (p.total !== total || index !== p.chunks.length) throw invalid();
    p.chunks.push(e.data);
    p.length += e.data.length;
    this.length += e.data.length;
    if (index + 1 !== total) return undefined;
    this.pending.delete(e.id);
    this.seen.add(e.id);
    this.length -= p.length;
    const encoded = p.chunks.join("");
    const data = Buffer.from(encoded, "base64");
    if (!data.length || data.length > MAX_BRAIN_IMAGE_BYTES || data.toString("base64") !== encoded) throw invalid();
    // Do not turn arbitrary model output (HTML/SVG/script) into an active file on the hub's origin.
    const ext = data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "png"
      : data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "jpg"
      : data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP" ? "webp" : undefined;
    if (!ext) throw invalid();
    return { data, ext };
  }

  /** Missing chunks are visible, rather than a silent missing picture. */
  finish(): boolean {
    const incomplete = this.pending.size > 0;
    this.pending.clear();
    this.length = 0;
    return incomplete;
  }
}

/** A fresh file in this session's workspace; neither a model-supplied filename nor savedPath is opened. */
export function saveBrainImage(root: string, workspace: string, image: { data: Buffer; ext: string }): string {
  mkdirSync(workspace, { recursive: true });
  const realRoot = realpathSync(root);
  const realWorkspace = realpathSync(workspace);
  if (!realWorkspace.startsWith(realRoot + sep)) throw new Error("Generated image workspace is outside the hub's workspaces.");
  const dir = mkdtempSync(join(realWorkspace, "generated-image-"));
  const file = join(dir, `image.${image.ext}`);
  writeFileSync(file, image.data, { mode: 0o640, flag: "wx" });
  return `file:${relative(realRoot, file).split(sep).join("/")}`;
}
