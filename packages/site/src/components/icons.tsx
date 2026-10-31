// The site's few icons, drawn inline (no icon font, no outside requests). Stroke icons follow lucide's 24px grid.

import { useId, type SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Stroke({ size = 18, children, ...p }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {children}
    </svg>
  );
}

/** The owl from the app icon: two amber eyes and a beak on warm ink. */
export function OwlMark({ size = 28, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const eye = (cx: number) => (
    <g>
      <circle cx={cx} cy="29.6" r="10.9" fill={`url(#e${uid})`} />
      <circle cx={cx} cy="29.6" r="6.6" fill="#0f0d0b" />
      <circle cx={cx + 2.75} cy="26.1" r="1.6" fill="#f6f1e8" />
    </g>
  );
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`t${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f2a25" />
          <stop offset="1" stopColor="#11100e" />
        </linearGradient>
        <linearGradient id={`e${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd774" />
          <stop offset="1" stopColor="#f7ad2c" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#t${uid})`} />
      <rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="none" stroke="#fff" strokeOpacity="0.07" />
      {eye(20.6)}
      {eye(43.4)}
      <rect x="27" y="42.4" width="10" height="2.9" rx="1.45" fill="#f6f1e8" />
    </svg>
  );
}

export const Apple = ({ size = 18, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.08 2.65-2.14.84-1.22 1.18-2.41 1.2-2.47-.03-.01-2.3-.88-2.32-3.5zM14.2 6.1c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.96-.49 2.56-1.23z" />
  </svg>
);

export const Windows = ({ size = 18, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M3 5.3 10.4 4.3v7.1H3V5.3zm0 13.4 7.4 1v-7.1H3v6.1zm8.3 1.1L21 21.1v-8.5h-9.7v7.2zm0-15.6v7.2H21V2.9l-9.7 1.3z" />
  </svg>
);

export const GitHub = ({ size = 18, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.7c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.66.35-1.12.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.04 1.03-2.76-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.64 1.03 2.76 0 3.94-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.6.69.49A10.25 10.25 0 0 0 22 12.25C22 6.58 17.52 2 12 2z" />
  </svg>
);

export const Docker = ({ size = 18, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M13.98 11.08h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19h-2.12a.19.19 0 0 0-.18.19v1.88c0 .1.08.19.18.19m-2.95-5.43h2.12a.19.19 0 0 0 .18-.19V3.58a.19.19 0 0 0-.18-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m0 2.71h2.12a.19.19 0 0 0 .18-.18V6.29a.19.19 0 0 0-.18-.18h-2.12a.19.19 0 0 0-.19.18v1.89c0 .1.09.18.19.18m-2.93 0h2.12a.19.19 0 0 0 .18-.18V6.29a.18.18 0 0 0-.18-.18H8.1a.19.19 0 0 0-.19.18v1.89c0 .1.09.18.19.18m-2.96 0h2.12a.19.19 0 0 0 .19-.18V6.29a.19.19 0 0 0-.19-.18H5.14a.19.19 0 0 0-.18.18v1.89c0 .1.08.18.18.18m5.89 2.72h2.12a.19.19 0 0 0 .18-.19V9.01a.19.19 0 0 0-.18-.19h-2.12a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m-2.93 0h2.12a.18.18 0 0 0 .18-.19V9.01a.18.18 0 0 0-.18-.19H8.1a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19m-2.96 0h2.12a.19.19 0 0 0 .19-.19V9.01a.19.19 0 0 0-.19-.19H5.14a.19.19 0 0 0-.18.19v1.88c0 .1.08.19.18.19m-2.92 0h2.12a.19.19 0 0 0 .18-.19V9.01a.19.19 0 0 0-.18-.19H2.22a.19.19 0 0 0-.19.19v1.88c0 .1.09.19.19.19M23.76 9.9c-.06-.05-.67-.51-1.95-.51-.34 0-.68.03-1.01.09a3.77 3.77 0 0 0-1.72-2.57l-.34-.2-.23.33c-.29.44-.5.94-.62 1.46-.23.97-.09 1.88.4 2.66a4.7 4.7 0 0 1-1.74.42H.75a.75.75 0 0 0-.75.75c-.01 1.4.22 2.79.7 4.1.54 1.43 1.35 2.49 2.4 3.13 1.18.72 3.1 1.13 5.27 1.13.98 0 1.96-.09 2.92-.27a12.2 12.2 0 0 0 3.82-1.39c.98-.57 1.87-1.29 2.62-2.14 1.26-1.42 2-3.01 2.56-4.42h.22c1.37 0 2.21-.55 2.68-1.01.31-.29.55-.65.71-1.05l.1-.29-.23-.17z" />
  </svg>
);

export const Star = (p: P) => (
  <Stroke {...p}>
    <path d="M12 3.5 14.6 9l6 .6-4.5 4 1.3 5.9L12 16.6l-5.4 2.9L7.9 13.6 3.4 9.6l6-.6z" />
  </Stroke>
);
export const ArrowDown = (p: P) => (
  <Stroke {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Stroke>
);
export const ArrowRight = (p: P) => (
  <Stroke {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Stroke>
);
export const Replay = (p: P) => (
  <Stroke {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </Stroke>
);
export const Check = (p: P) => (
  <Stroke {...p}>
    <path d="M5 12.5 10 17 19 7" />
  </Stroke>
);
export const Copy = (p: P) => (
  <Stroke {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Stroke>
);
export const Lock = (p: P) => (
  <Stroke {...p}>
    <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </Stroke>
);
export const ThumbUp = (p: P) => (
  <Stroke {...p}>
    <path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H7V10l4-8a3 3 0 0 1 4 3.9z" />
  </Stroke>
);
export const Box = (p: P) => (
  <Stroke {...p}>
    <path d="M21 8 12 3 3 8v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5M12 13v8" />
  </Stroke>
);
export const Filter = (p: P) => (
  <Stroke {...p}>
    <path d="M3 5h18l-7 8.5V20l-4-2v-4.5z" />
  </Stroke>
);
export const Chain = (p: P) => (
  <Stroke {...p}>
    <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6" />
    <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
  </Stroke>
);
export const Brain = (p: P) => (
  <Stroke {...p}>
    <path d="M9 4.5a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10.5a3 3 0 0 0 1 2.2A3 3 0 0 0 6 18a3 3 0 0 0 3 2.5V4.5z" />
    <path d="M15 4.5a3 3 0 0 1 3 3v.2a3 3 0 0 1 2 2.8 3 3 0 0 1-1 2.2A3 3 0 0 1 18 18a3 3 0 0 1-3 2.5V4.5z" />
    <path d="M9 4.5a3 3 0 0 1 6 0M9 20.5h6" />
  </Stroke>
);
export const Laptop = (p: P) => (
  <Stroke {...p}>
    <rect x="4" y="5" width="16" height="11" rx="2" />
    <path d="M2 19.5h20" />
  </Stroke>
);
export const Home = (p: P) => (
  <Stroke {...p}>
    <path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z" />
  </Stroke>
);
export const Bell = (p: P) => (
  <Stroke {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 21h4" />
  </Stroke>
);
export const Mic = (p: P) => (
  <Stroke {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Stroke>
);
export const FaceId = (p: P) => (
  <Stroke {...p}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9.5 16a3.5 3.5 0 0 0 5 0" />
  </Stroke>
);
export const Globe = (p: P) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Stroke>
);
export const Play = ({ size = 18, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.4C8.9 4.3 8 4.8 8 5.6z" />
  </svg>
);
export const Close = (p: P) => (
  <Stroke {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Stroke>
);
export const ChevronLeft = (p: P) => (
  <Stroke {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Stroke>
);
export const ChevronRight = (p: P) => (
  <Stroke {...p}>
    <path d="M9 6l6 6-6 6" />
  </Stroke>
);

export const Sun = (p: P) => (
  <Stroke {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Stroke>
);

export const Plug = (p: P) => (
  <Stroke {...p}>
    <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />
  </Stroke>
);

export const Layout = (p: P) => (
  <Stroke {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </Stroke>
);

export const Rss = (p: P) => (
  <Stroke {...p}>
    <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
    <circle cx="5" cy="19" r="1" />
  </Stroke>
);

export const Mail = (p: P) => (
  <Stroke {...p}>
    <rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </Stroke>
);

export const Share = (p: P) => (
  <Stroke {...p}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13" />
  </Stroke>
);

export const ChevronDown = (p: P) => (
  <Stroke {...p}>
    <path d="m6 9 6 6 6-6" />
  </Stroke>
);

export const Pointer = (p: P) => (
  <Stroke {...p}>
    <path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />
  </Stroke>
);
