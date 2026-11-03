import type { BrainEvent } from "./types.ts";

/** Generated pictures have the same 30 MB limit as show_images workspace files. */
export const MAX_BRAIN_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_BRAIN_IMAGE_BASE64 = Math.ceil(MAX_BRAIN_IMAGE_BYTES / 3) * 4;
/** Keep each brain.event comfortably below the smallest hub/node WebSocket limit (4 MB). */
export const BRAIN_IMAGE_CHUNK_CHARS = 256 * 1024;

/** Inline image output, in bounded frames. Bytes travel only to the hub, never into message history or logs. */
export function brainImageEvents(id: string, data: string): BrainEvent[] {
  if (data.length > MAX_BRAIN_IMAGE_BASE64) return [{ type: "warning", message: "Generated image exceeds 30 MB; it was not shown." }];
  const total = Math.ceil(data.length / BRAIN_IMAGE_CHUNK_CHARS);
  return Array.from({ length: total }, (_, index) => ({
    type: "image", id, data: data.slice(index * BRAIN_IMAGE_CHUNK_CHARS, (index + 1) * BRAIN_IMAGE_CHUNK_CHARS), chunk: { index, total },
  }));
}
