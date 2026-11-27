// Where the note of a frame goes on the picture. Pure.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const GAP = 8;
const EDGE = 8;

/** Where the card goes in the layer: under the frame, above it when there is no room, else at the layer's bottom. */
export function placeNote(frame: Box, layer: { width: number; height: number }, card: { width: number; height: number }): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(frame.left, layer.width - card.width - EDGE));
  const below = frame.top + frame.height + GAP;
  if (below + card.height <= layer.height - EDGE) return { left, top: below };
  const above = frame.top - GAP - card.height;
  return { left, top: above >= EDGE ? above : Math.max(EDGE, layer.height - card.height - EDGE) };
}
