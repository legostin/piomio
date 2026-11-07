// The watch's page reader (extract.ts): turns one loaded page at a time into the value a watch compares, off the hub's
// event loop. A page that takes too long here takes only this thread, which the hub then ends.

import { parentPort } from "node:worker_threads";
import { TriggerError, type ErrorParams } from "./errors.ts";
import { extractValue } from "./watch.ts";

export interface ExtractJob {
  id: number;
  body: string;
  contentType: string;
  opts: { selector?: string; jsonPath?: string };
}

export interface ExtractReply {
  id: number;
  value?: string;
  /** What extractValue threw; `code` and `params` when it was a TriggerError (WatchError). */
  error?: { message: string; code?: string; params?: ErrorParams };
}

parentPort?.on("message", (job: ExtractJob) => {
  let reply: ExtractReply;
  try {
    reply = { id: job.id, value: extractValue(job.body, job.contentType, job.opts) };
  } catch (e) {
    const error = e instanceof TriggerError ? { message: e.message, code: e.code, params: e.params } : { message: e instanceof Error ? e.message : String(e) };
    reply = { id: job.id, error };
  }
  parentPort!.postMessage(reply);
});
