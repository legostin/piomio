// Shared UI primitives. Button, Card, Badge, EmptyState and Spinner are also exposed to UI plugins (@piomio/ui).

import { WindowTitlebar } from "./WindowTitlebar";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Loader2, X } from "lucide-react";
import type { BadgeProps, ButtonProps, CardProps, EmptyStateProps } from "@piomio/ui";
import { Icon } from "./icon";
import { mergeClasses } from "../lib/classes";
import { t } from "../i18n";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------- Button ----------

// Pills, like the quick replies in messages. The primary one is amber candy: one per screen.
const BTN_VARIANTS = {
  primary: "candy font-semibold",
  secondary: "bg-surface text-fg border border-hairline shadow-[0_1px_2px_rgb(70_45_10/0.06)] hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  danger: "bg-danger-soft text-danger hover:brightness-95 border border-transparent",
} as const;

export function Button(
  props: ButtonProps & { className?: string; icon?: ReactNode; loading?: boolean; form?: string; "aria-label"?: string },
) {
  const { children, onClick, variant = "secondary", size = "md", disabled, title, type = "button", className, icon, loading, form } = props;
  return (
    <button
      type={type}
      form={form}
      title={title}
      aria-label={props["aria-label"]}
      disabled={disabled || loading}
      onClick={onClick}
      className={cx(
        "press inline-flex items-center justify-center gap-1.5 rounded-full font-medium select-none whitespace-nowrap",
        "disabled:opacity-45 disabled:pointer-events-none",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-[18px] text-sm",
        BTN_VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton(props: { label: string; onClick?: () => void; children: ReactNode; className?: string; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        "press inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40",
        props.active && "bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text",
        props.className,
      )}
    >
      {props.children}
    </button>
  );
}

// ---------- Card ----------

export function Card({ title, actions, children, className }: CardProps) {
  return (
    <section className={cx("rounded-2xl border border-hairline bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3.5 pb-0.5">
          <div className="min-w-0 font-semibold">{title}</div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// ---------- Badge ----------

const TONES = {
  neutral: "bg-surface-2 text-muted",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
} as const;

export function Badge({ children, tone = "neutral", className, dot }: BadgeProps & { className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONES[tone], className)}>
      {dot && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}

// ---------- EmptyState / Spinner ----------

/** Nothing here yet: a glyph on a paper tile in a soft amber glow (or `art`), a title in the display face, a hint. */
export function EmptyState({ title, hint, icon, art }: EmptyStateProps & { art?: ReactNode }) {
  return (
    <div className="animate-in flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="hero-halo mb-3">
        {art ?? (
          <div className="flex size-14 items-center justify-center rounded-[18px] border border-hairline bg-surface text-accent-text shadow-card">
            <Icon name={icon ?? "sparkles"} className="size-6" />
          </div>
        )}
      </div>
      <div className="font-display text-[17px] font-semibold text-balance">{title}</div>
      {hint && <div className="max-w-sm text-sm leading-relaxed text-balance text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <Loader2 style={{ width: size, height: size }} className={cx("animate-spin text-muted", className)} aria-label={t("common.loading")} />;
}

export function Loading({ text }: { text?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <Spinner /> {text ?? t("common.loading")}
    </div>
  );
}

export function ErrorNote({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

// ---------- form controls ----------

const CONTROL = "w-full rounded-xl border border-border bg-surface px-3.5 text-sm text-fg placeholder:text-muted/70 transition focus:border-accent focus:outline-none focus:ring-4 focus:ring-accent/20 disabled:opacity-60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={mergeClasses(`${CONTROL} h-10`, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={mergeClasses(`${CONTROL} py-2 leading-relaxed`, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={mergeClasses(`${CONTROL} h-10 pr-8`, props.className)} />;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  const labelId = useId();
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2.5 text-sm select-none", disabled && "pointer-events-none opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200", checked ? "candy" : "bg-surface-3")}
      >
        <span
          className={cx(
            "inline-block size-5 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)]",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </button>
      {label && <span id={labelId}>{label}</span>}
    </label>
  );
}

/** Labelled form row. Use group for composite controls (chips, lists) so clicks on the label do not hit inner buttons. */
export function Field({ label, hint, error, children, className, group }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string; group?: boolean }) {
  const Tag = group ? "div" : "label";
  return (
    <Tag className={cx("flex flex-col gap-1.5", className)} role={group ? "group" : undefined}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs leading-relaxed text-muted">{hint}</span> : null}
    </Tag>
  );
}

/** Editable list of short strings (globs, hosts, times) as chips with an input. */
export function TagInput({ value, onChange, placeholder, inputType = "text" }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; inputType?: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface p-1.5 focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/20">
      {value.map((v, i) => (
        <span key={v + i} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pr-1 pl-2 font-mono text-xs">
          {v}
          <button type="button" aria-label={t("common.removeItem", { value: v })} className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        type={inputType}
        value={draft}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        className="h-7 min-w-24 flex-1 bg-transparent px-1.5 text-sm outline-none"
      />
    </div>
  );
}

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Remember what had focus before opening (read during render: an autoFocus child grabs focus before effects run).
  const restoreTo = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) restoreTo.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    window.addEventListener("keydown", onKey);
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreTo.current?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="window-modal fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="animate-fade absolute inset-0 bg-[rgb(20_14_6/0.32)] backdrop-blur-[6px]" onClick={onClose} />
      <WindowTitlebar className="absolute inset-x-0 top-0 z-10" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "animate-zoom relative flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-hairline bg-surface shadow-pop outline-none sm:rounded-3xl",
          wide ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
      >
        <div className="flex items-center justify-between gap-3 pt-3.5 pr-3 pb-1 pl-5">
          <h2 id={titleId} className="min-w-0 truncate text-base font-semibold">
            {title}
          </h2>
          <IconButton label={t("common.close")} onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="pb-safe flex flex-wrap justify-end gap-2 px-5 pt-1 pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------- Copy ----------

export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx("inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition hover:bg-surface-2 hover:text-fg", className)}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}

export function CodeLine({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-hairline bg-code-bg px-3 py-2">
      <code className="min-w-0 flex-1 font-mono text-[13px] break-all whitespace-pre-wrap">{children}</code>
      <CopyButton text={children} label="" />
    </div>
  );
}

// ---------- page scaffolding ----------

/** Pages rendered inside the settings panel drop their big title (the panel header shows it) and the wide margins. */
export const EmbeddedPage = createContext(false);

export function Page({
  title,
  subtitle,
  actions,
  children,
  className,
  subtitleClassName,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Extra classes of the subtitle beside the actions in the settings panel (a page whose actions would squeeze it). */
  subtitleClassName?: string;
}) {
  const embedded = useContext(EmbeddedPage);
  if (embedded)
    return (
      <div className={cx("px-4 py-4 sm:px-5", className)}>
        {(subtitle || actions) && (
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            {subtitle ? <p className={cx("min-w-0 flex-1 text-sm text-muted", subtitleClassName)}>{subtitle}</p> : <span />}
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </div>
    );
  return (
    <div className="h-full overflow-y-auto">
      <div className={cx("mx-auto w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-10", className)}>
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-display text-xl font-semibold sm:text-2xl">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A segmented switch; its thumb slides to the chosen option. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  compact,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; dot?: boolean; title?: string }>;
  className?: string;
  /** Tighter options, for a narrow column. */
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);
  const index = options.findIndex((o) => o.value === value);
  useLayoutEffect(() => {
    const measure = () => {
      const el = box.current?.querySelectorAll<HTMLElement>("[data-seg]")[index];
      setThumb(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !box.current) return;
    const ro = new ResizeObserver(measure);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [index, options.length]);
  return (
    <div ref={box} role="tablist" className={cx("no-scrollbar relative inline-flex max-w-full overflow-x-auto rounded-full bg-surface-2 p-[3px]", className)}>
      {thumb && (
        <span
          aria-hidden
          className="absolute top-[3px] bottom-[3px] rounded-full bg-surface shadow-[0_1px_2px_rgb(70_45_10/0.1),0_3px_10px_-3px_rgb(70_45_10/0.16)] transition-[left,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:bg-surface-3"
          style={{ left: thumb.left, width: thumb.width }}
        />
      )}
      {options.map((o) => (
        <button
          key={o.value}
          data-seg
          type="button"
          role="tab"
          title={o.title}
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "relative z-[1] flex items-center justify-center gap-1.5 rounded-full py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors",
            compact ? "min-w-0 flex-1 px-2" : "shrink-0 px-3.5",
            value === o.value ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          <span className="truncate">{o.label}</span>
          {o.dot && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  );
}
