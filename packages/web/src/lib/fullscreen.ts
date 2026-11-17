// Something covers the whole window (a page, a position's page, a map full screen): the chat's composer steps aside
// (index.css), the phone app hides its header, and the page behind does not scroll. Holders nest (a map full screen
// over a position's page): the window is itself again when the last one lets go.

import { native } from "./native";

let holders = 0;
let overflow = "";

/** Hold the window full screen; call the returned function to let go. */
export function holdFullscreen(): () => void {
  if (holders++ === 0) {
    document.documentElement.classList.add("owl-map-full");
    native?.call("fullscreen", { on: true }).catch(() => {});
    overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holders > 0) return;
    document.documentElement.classList.remove("owl-map-full");
    native?.call("fullscreen", { on: false }).catch(() => {});
    document.body.style.overflow = overflow;
  };
}
