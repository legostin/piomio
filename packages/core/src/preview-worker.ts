// The preview worker (picture-previews.ts): turns one picture file at a time into its small copy, off the hub's event loop.

import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { makePreview } from "./preview-image.ts";

export interface PreviewJob {
  id: number;
  file: string;
  type: string;
}

export interface PreviewReply {
  id: number;
  data?: Uint8Array;
  type?: string;
  error?: string;
}

parentPort?.on("message", (job: PreviewJob) => {
  let reply: PreviewReply;
  try {
    const p = makePreview(readFileSync(job.file), job.type);
    reply = p ? { id: job.id, data: p.data, type: p.type } : { id: job.id };
  } catch (e) {
    reply = { id: job.id, error: e instanceof Error ? e.message : String(e) };
  }
  parentPort!.postMessage(reply, reply.data ? [reply.data.buffer as ArrayBuffer] : []);
});
