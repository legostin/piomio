// An OpenStreetMap map an agent shows (a `map` part): places with symbols, a route along roads, one caption line with
// "Open in…" for the maps apps (built in, and from plugins). As little as possible until it is wanted: the zoom
// buttons show once the map is in use, the list of places only full screen. Leaflet loads on demand, once the card
// scrolls into view, so the main bundle stays small; tiles come through the hub (/api/map/tiles), which caches them.
// In the chat the map ignores the scroll wheel (and, on touch screens, one-finger drags) until it is clicked, so the
// chat scrolls past it freely; full screen it takes every gesture.

import { WindowTitlebar } from "../../components/WindowTitlebar";
import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  BedDouble,
  Bike,
  Briefcase,
  Bus,
  Camera,
  Car,
  ChevronDown,
  Coffee,
  ExternalLink,
  Flag,
  Footprints,
  Fuel,
  Hospital,
  House,
  Landmark,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Minimize2,
  Minus,
  Navigation2,
  Palette,
  Plus,
  Scan,
  ShoppingBag,
  SquareParking,
  Star,
  TramFront,
  Trees,
  Utensils,
  Wine,
} from "lucide-react";
import type { MapIcon as MarkerIcon, MapMarker, MessagePart, RouteMode } from "@piomio/shared";
import type * as Leaflet from "leaflet";
import { formatCoords, OSM_COPYRIGHT, TILE_URL } from "../../lib/media";
import { appLink, BUILTIN_MAP_APPS, formatDistance, formatTravelTime, mapTarget } from "../../lib/maps";
import { usePluginRegistry } from "../../plugins/slots";
import { cx } from "../../components/ui";
import { native } from "../../lib/native";
import { t, type MessageKey } from "../../i18n";

type MapPart = Extract<MessagePart, { type: "map" }>;
type IconType = ComponentType<{ className?: string; strokeWidth?: number }>;

/** Each symbol's glyph and colour: saturated, so the white glyph reads on the light and the dark map alike. */
const SYMBOLS: Record<MarkerIcon, { Icon: IconType; color: string }> = {
  pin: { Icon: MapPin, color: "#1f2937" },
  food: { Icon: Utensils, color: "#ea580c" },
  cafe: { Icon: Coffee, color: "#b45309" },
  bar: { Icon: Wine, color: "#9333ea" },
  hotel: { Icon: BedDouble, color: "#7c3aed" },
  sight: { Icon: Landmark, color: "#ca8a04" },
  museum: { Icon: Palette, color: "#a16207" },
  park: { Icon: Trees, color: "#16a34a" },
  shop: { Icon: ShoppingBag, color: "#db2777" },
  transport: { Icon: Bus, color: "#2563eb" },
  parking: { Icon: SquareParking, color: "#1d4ed8" },
  fuel: { Icon: Fuel, color: "#0f766e" },
  hospital: { Icon: Hospital, color: "#dc2626" },
  home: { Icon: House, color: "#475569" },
  work: { Icon: Briefcase, color: "#334155" },
  photo: { Icon: Camera, color: "#0891b2" },
  star: { Icon: Star, color: "#d97706" },
  start: { Icon: Navigation2, color: "#16a34a" },
  finish: { Icon: Flag, color: "#dc2626" },
  user: { Icon: Navigation2, color: "#2563eb" },
};
const ROUTE_COLOR = "#e07b00";

const MODES: Record<RouteMode, { Icon: IconType; label: MessageKey }> = {
  walk: { Icon: Footprints, label: "message.map.mode.walk" },
  drive: { Icon: Car, label: "message.map.mode.drive" },
  bike: { Icon: Bike, label: "message.map.mode.bike" },
  transit: { Icon: TramFront, label: "message.map.mode.transit" },
};

const BUILTIN_TITLES: Record<string, MessageKey> = {
  apple: "message.map.app.apple",
  google: "message.map.app.google",
  osm: "message.map.app.osm",
};

let leaflet: Promise<typeof Leaflet> | undefined;
function loadLeaflet(): Promise<typeof Leaflet> {
  leaflet ??= Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]).then(([m]) => ((m as unknown as { default?: typeof Leaflet }).default ?? m) as typeof Leaflet);
  return leaflet;
}

/** Text in a tooltip as a DOM node: Leaflet would put a string in as HTML, and labels come from the model. */
function label(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

/** A place on the map: its symbol, or its number on the route when it has none. */
interface Spot extends MapMarker {
  /** 1-based place on the route, for stops without a symbol of their own. */
  n?: number;
}

function spotsOf(part: MapPart): Spot[] {
  const markers = part.markers?.length ? part.markers : [{ lat: part.lat, lon: part.lon, ...(part.title ? { label: part.title } : {}) }];
  const order = new Map(part.route?.stops.map((m, i) => [m, i + 1]));
  return markers.map((m, i) => (order.has(i) && (!m.icon || m.icon === "pin") ? { ...m, n: order.get(i) } : m));
}

function Glyph({ spot }: { spot: Spot }) {
  if (spot.icon === "user") return null;
  if (spot.n !== undefined) return <span className="owl-marker-n">{spot.n}</span>;
  const { Icon } = SYMBOLS[spot.icon ?? "pin"];
  return <Icon className="size-4" strokeWidth={2.25} />;
}

function colorOf(spot: Spot): string {
  return spot.n !== undefined ? ROUTE_COLOR : SYMBOLS[spot.icon ?? "pin"].color;
}

export function MapCard({ part }: { part: MapPart }) {
  const card = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fullNow = useRef(false);
  const map = useRef<Leaflet.Map | undefined>(undefined);
  const pins = useRef<Leaflet.Marker[]>([]);
  const fit = useRef<() => void>(() => {});
  const activate = useRef<(on: boolean) => void>(() => {});
  const [state, setState] = useState<"idle" | "ready" | "error">("idle");
  const [active, setActive] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [full, setFull] = useState(false);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [menu, setMenu] = useState(false);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const { mapApps } = usePluginRegistry();
  const spots = spotsOf(part);
  const place = part.title ?? formatCoords(part.lat, part.lon);
  const key = JSON.stringify([part.lat, part.lon, part.zoom, part.title, part.markers, part.route]);
  const listed = full && ((part.markers?.length ?? 0) >= 2 || !!part.markers?.some((m) => m.note));

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let m: Leaflet.Map | undefined;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const start = async () => {
      let L: typeof Leaflet;
      try {
        L = await loadLeaflet();
      } catch {
        if (!cancelled) setState("error");
        return;
      }
      if (cancelled) return;
      const touch = matchMedia("(pointer: coarse)").matches;
      m = L.map(el, { scrollWheelZoom: false, dragging: !touch, zoomControl: false, attributionControl: false, zoomSnap: 0.5, worldCopyJump: true });
      map.current = m;
      L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(m);
      const link = document.createElement("a");
      link.href = OSM_COPYRIGHT;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = t("message.map.attribution");
      L.tileLayer(TILE_URL, { maxZoom: 19, minZoom: 1, attribution: link.outerHTML }).addTo(m);

      // The route under the places: a light casing, then the line (dashed for transit, which is drawn straight).
      const path = part.route?.path ?? [];
      if (path.length >= 2) {
        L.polyline(path, { className: "owl-route-casing", weight: 9, interactive: false }).addTo(m);
        L.polyline(path, { className: cx("owl-route", part.route?.mode === "transit" && "owl-route-transit"), weight: 5, interactive: false }).addTo(m);
      }

      // Places: a symbol drawn by React into each marker's element (setSlots), labels as tooltips.
      const els: HTMLElement[] = [];
      pins.current = spots.map((s, i) => {
        const dot = document.createElement("div");
        dot.className = cx("owl-marker", s.icon === "user" && "owl-marker-user");
        dot.style.setProperty("--marker", colorOf(s));
        els.push(dot);
        const icon = L.divIcon({ className: "owl-marker-wrap", html: dot, iconSize: [30, 30], iconAnchor: [15, 15], tooltipAnchor: [0, -14] });
        const mk = L.marker([s.lat, s.lon], { icon, keyboard: false, zIndexOffset: s.icon === "user" ? 1000 : 0 }).addTo(m!);
        const own = !!part.markers?.length;
        if (s.label) mk.bindTooltip(label(s.label), { permanent: own && spots.length <= 6, direction: "top", className: "owl-map-label", opacity: 1 });
        if (own && spots.length > 1) mk.on("click", () => setSelected((cur) => (cur === i ? undefined : i)));
        return mk;
      });
      setSlots(els);

      const bounds = L.latLngBounds([...spots.map((s) => [s.lat, s.lon] as [number, number]), ...path]);
      fit.current = () => {
        if (!m) return;
        if (spots.length > 1 || path.length > 1) m.fitBounds(bounds, { padding: [44, 44], maxZoom: 16 });
        else m.setView([part.lat, part.lon], part.zoom ?? 15);
      };
      if (part.zoom) m.setView([part.lat, part.lon], part.zoom);
      else fit.current();

      // Interactive after a click; leaving the map (or touching outside it) makes the page scroll again.
      activate.current = (on: boolean) => {
        if (!m) return;
        if (on) {
          m.scrollWheelZoom.enable();
          m.dragging.enable();
        } else {
          m.scrollWheelZoom.disable();
          if (touch) m.dragging.disable();
        }
        setActive(on);
      };
      m.on("click", () => activate.current(true));
      m.on("zoomstart", () => setNudge(false));
      // The card's own buttons and list count as inside; full screen the map stays active.
      const outside = (e: PointerEvent) => !fullNow.current && !card.current?.contains(e.target as Node) && activate.current(false);
      const leave = () => !fullNow.current && activate.current(false);
      const host = card.current ?? el;
      host.addEventListener("mouseleave", leave);
      document.addEventListener("pointerdown", outside);
      cleanups.push(() => {
        host.removeEventListener("mouseleave", leave);
        document.removeEventListener("pointerdown", outside);
      });
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => m?.invalidateSize());
        ro.observe(el);
        cleanups.push(() => ro.disconnect());
      }
      setState("ready");
    };

    if (typeof IntersectionObserver === "undefined") void start();
    else {
      const io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          io.disconnect();
          void start();
        },
        { rootMargin: "300px" },
      );
      io.observe(el);
      cleanups.push(() => io.disconnect());
    }
    return () => {
      cancelled = true;
      for (const c of cleanups) c();
      m?.remove();
      map.current = undefined;
      pins.current = [];
      setSlots([]);
      setState("idle");
      setActive(false);
      setSelected(undefined);
    };
    // The part's content is the dependency: a new object with the same content must not rebuild the map.
  }, [key]);

  // A touch on an inactive map says how to use it, for a moment.
  useEffect(() => {
    if (!nudge) return;
    const id = setTimeout(() => setNudge(false), 1800);
    return () => clearTimeout(id);
  }, [nudge]);

  // Full screen: every gesture is the map's, Escape leaves, the page behind does not scroll.
  useEffect(() => {
    fullNow.current = full;
    // The map's box changed size: everything back in view, once the new layout is there.
    const frame = requestAnimationFrame(() => {
      map.current?.invalidateSize();
      if (selected === undefined) fit.current();
    });
    if (!full) return () => cancelAnimationFrame(frame);
    activate.current(true);
    // Nothing over the map: the chat's composer hides (index.css), and the phone app hides its header.
    document.documentElement.classList.add("owl-map-full");
    native?.call("fullscreen", { on: true }).catch(() => {});
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", esc);
    return () => {
      cancelAnimationFrame(frame);
      document.documentElement.classList.remove("owl-map-full");
      native?.call("fullscreen", { on: false }).catch(() => {});
      document.removeEventListener("keydown", esc);
      document.body.style.overflow = overflow;
      activate.current(false);
    };
    // Only entering and leaving full screen re-fit the map, not choosing a place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  // The chosen place: raised, labelled, in view.
  useEffect(() => {
    pins.current.forEach((mk, i) => {
      slots[i]?.classList.toggle("is-selected", i === selected);
      if (i === selected) {
        mk.openTooltip();
        map.current?.flyTo(mk.getLatLng(), Math.max(map.current.getZoom(), 16), { duration: 0.6 });
      }
    });
  }, [selected, slots]);

  // The "Open in…" menu closes on a click elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menu]);

  const route = part.route;
  const Mode = route ? MODES[route.mode] : undefined;
  const aim = mapTarget(part, selected);
  const links = [...BUILTIN_MAP_APPS.map((a) => ({ ...a, key: a.id, title: t(BUILTIN_TITLES[a.id]) })), ...mapApps].flatMap((a) => {
    const href = appLink(a, aim);
    return href ? [{ key: a.key, title: a.title, href }] : [];
  });
  const target = selected !== undefined ? (spots[selected].label ?? t("message.map.point", { n: selected + 1 })) : route ? t("message.map.route") : place;

  const button = "glass press flex size-8 items-center justify-center rounded-full border border-hairline text-fg shadow-card hover:bg-surface";

  return (
    <figure
      ref={card}
      className={cx(
        "flex flex-col overflow-hidden bg-surface",
        full ? "window-overlay animate-zoom fixed inset-0 z-[70] m-0 pb-[env(safe-area-inset-bottom)]" : "w-full max-w-xl rounded-[22px] border border-hairline shadow-card",
      )}
      aria-label={t("message.map.label", { place })}
    >
      {full && <WindowTitlebar />}
      <div className={cx("group/map relative isolate", full ? "min-h-0 flex-1" : route ? "h-[300px]" : "h-[260px]")} onTouchStart={() => !active && !full && setNudge(true)}>
        <div ref={box} className="owl-map absolute inset-0" />
        {slots.map((el, i) => createPortal(<Glyph spot={spots[i]} />, el, `glyph-${i}`))}
        {state !== "ready" && (
          <div className={cx("pointer-events-none absolute inset-0 z-[1] flex flex-col items-center justify-center gap-2 bg-surface-2 text-sm text-muted", state === "idle" && "animate-pulse")}>
            <MapIcon className="size-6" />
            {state === "error" && t("message.map.failed")}
          </div>
        )}
        {state === "ready" && (
          <div className="absolute top-2 right-2 z-[1000] flex flex-col gap-1">
            {(active || full) && (
              <>
                <button type="button" className={button} title={t("message.map.zoomIn")} aria-label={t("message.map.zoomIn")} onClick={() => map.current?.zoomIn()}>
                  <Plus className="size-4" />
                </button>
                <button type="button" className={button} title={t("message.map.zoomOut")} aria-label={t("message.map.zoomOut")} onClick={() => map.current?.zoomOut()}>
                  <Minus className="size-4" />
                </button>
                <button
                  type="button"
                  className={button}
                  title={t("message.map.fit")}
                  aria-label={t("message.map.fit")}
                  onClick={() => {
                    setSelected(undefined);
                    fit.current();
                  }}
                >
                  <Scan className="size-4" />
                </button>
              </>
            )}
            <button
              type="button"
              className={button}
              title={t(full ? "message.map.exitFullscreen" : "message.map.fullscreen")}
              aria-label={t(full ? "message.map.exitFullscreen" : "message.map.fullscreen")}
              onClick={() => setFull((f) => !f)}
            >
              {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </div>
        )}
        {state === "ready" && !active && !full && (
          <div
            className={cx(
              "pointer-events-none absolute inset-x-0 bottom-3 z-[1000] flex justify-center transition-opacity duration-300",
              nudge ? "opacity-100" : "opacity-0 group-hover/map:opacity-100",
            )}
          >
            <span className="glass rounded-full border border-hairline px-3 py-1 text-xs font-medium text-fg shadow-card">{t("message.map.hint")}</span>
          </div>
        )}
      </div>

      {listed && (
        <ol className={cx("divide-y divide-border overflow-y-auto border-t border-border", full ? "max-h-[35vh]" : "max-h-56")}>
          {spots.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setSelected((cur) => (cur === i ? undefined : i))}
                className={cx("flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-surface-2", selected === i && "bg-surface-2")}
              >
                <span className={cx("owl-marker owl-marker-sm mt-0.5 shrink-0", s.icon === "user" && "owl-marker-user")} style={{ "--marker": colorOf(s) } as CSSProperties}>
                  <Glyph spot={s} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{s.label ?? t("message.map.point", { n: i + 1 })}</span>
                  {s.note && <span className="block text-[13px] text-muted">{s.note}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <figcaption className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          {Mode ? <Mode.Icon className="size-4" /> : <MapPin className="size-4" />}
        </span>
        <span className="min-w-0 flex-1 truncate" title={place}>
          <span className="font-medium">{place}</span>
          {route && (
            <span className="text-muted">
              {" · "}
              {route.distanceM !== undefined && route.durationS !== undefined
                ? `${formatDistance(route.distanceM)} · ${formatTravelTime(route.durationS)}`
                : t(Mode!.label)}
            </span>
          )}
        </span>
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenu((v) => !v);
            }}
            aria-expanded={menu}
            className="press inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-[12.5px] font-medium text-fg hover:bg-surface-3"
          >
            {t("message.map.openIn")} <ChevronDown className={cx("size-3.5 transition-transform", menu && "rotate-180")} />
          </button>
          {menu && (
            <div className="animate-zoom absolute right-0 bottom-full z-[1100] mb-1.5 w-56 origin-bottom-right overflow-hidden rounded-2xl border border-hairline bg-surface p-1 shadow-pop" onClick={(e) => e.stopPropagation()}>
              <div className="truncate px-2.5 py-1.5 text-xs text-muted">{target}</div>
              {links.map((l) => (
                <a
                  key={l.key}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setMenu(false)}
                  className="flex items-center justify-between rounded-xl px-2.5 py-1.5 text-sm text-fg transition-colors hover:bg-surface-2"
                >
                  {l.title}
                  <ExternalLink className="size-3.5 text-muted" />
                </a>
              ))}
            </div>
          )}
        </div>
      </figcaption>
    </figure>
  );
}
