// The serving hub's version, even when a different computer's desktop app displays it.
import { useStore } from "../lib/store";
import { desktopApp, type DesktopApp } from "../lib/desktop";
import { machineActivity, session } from "../state/app";
import { t } from "../i18n";

export function AppVersionView({ version, hubName, desktop, update }: { version?: string; hubName?: string; desktop?: DesktopApp; update?: string }) {
  if (!version) return null;
  const different = !!desktop?.version && desktop.version !== version;
  const details = [
    t("version.hub", { version }),
    hubName && t("version.machine", { name: hubName }),
    desktop && (desktop.version ? t("version.desktop", { version: desktop.version }) : t("version.desktopUnknown")),
    different && t("version.different"),
    update && t("version.update", { version: update }),
  ].filter(Boolean).join("\n");
  return (
    <span tabIndex={0} title={details} aria-label={details} className="inline-flex items-center gap-1.5 rounded text-[11px] leading-5 text-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">
      <span>v{version}</span>
      {(different || update) && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent" />}
    </span>
  );
}

export function AppVersion() {
  const s = useStore(session);
  const list = useStore(machineActivity);
  return <AppVersionView version={s?.version} hubName={s?.hubName} desktop={desktopApp()} update={list?.find((m) => m.id === "local")?.update} />;
}
