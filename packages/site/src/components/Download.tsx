// The download button: macOS by default (what the page is prerendered with), Windows once the browser says so. A phone
// can't run Piomio, so there the button sends the page's link on (the share sheet, or the clipboard) and the top bar
// points to GitHub.

import { useEffect, useState } from "react";
import { data } from "../data";
import { useI18n } from "../i18n";
import { Apple, GitHub, Share, Windows } from "./icons";

export type Os = "mac" | "win" | "phone";

export function useOs(): Os {
  const [os, setOs] = useState<Os>("mac");
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
    const p = `${nav.userAgentData?.platform ?? ""} ${navigator.platform} ${navigator.userAgent}`;
    // An iPad asking for the desktop site says "Mac" but has a touch screen.
    if (nav.userAgentData?.mobile || /iphone|ipad|ipod|android/i.test(p) || (/mac/i.test(navigator.platform) && navigator.maxTouchPoints > 1)) setOs("phone");
    else if (/win/i.test(p)) setOs("win");
  }, []);
  return os;
}

export function downloadHref(os: "mac" | "win"): string {
  return (os === "mac" ? data.release.mac : data.release.win) ?? data.release.page;
}

function ShareLink() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = location.href.split("#")[0];
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await navigator.clipboard?.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button type="button" onClick={() => void share()} className="candy inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-[16px] font-semibold">
      <Share size={18} />
      {t(copied ? "hero.shared" : "hero.share")}
    </button>
  );
}

export function DownloadButton({ size = "lg" }: { size?: "sm" | "lg" }) {
  const { t } = useI18n();
  const os = useOs();
  if (os === "phone")
    return size === "sm" ? (
      <a href={`https://github.com/${data.repo}`} className="candy inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[14px] font-semibold">
        <GitHub size={15} />
        GitHub
      </a>
    ) : (
      <ShareLink />
    );
  const Icon = os === "mac" ? Apple : Windows;
  if (size === "sm")
    return (
      <a href={downloadHref(os)} className="candy inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[14px] font-semibold">
        <Icon size={15} />
        {t("nav.download")}
      </a>
    );
  return (
    <a href={downloadHref(os)} className="candy inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-[16px] font-semibold">
      <Icon size={19} />
      {t(os === "mac" ? "hero.downloadMac" : "hero.downloadWin")}
    </a>
  );
}
