// Markdown renderer for messages. Raw HTML is never rendered: HTML nodes are turned into plain text.

import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageIcon, Lock } from "lucide-react";
import { t } from "../i18n";
import { mediaSrc } from "../lib/media";
import { imageDownload } from "../lib/gallery";
import { openViewer } from "../state/viewer";
import { remarkUserText } from "../lib/user-markdown";
import { openOutside } from "../lib/native";
import { CopyButton, cx } from "./ui";
import { PictureGate } from "./picture";

type MdNode = { type: string; value?: string; children?: MdNode[] };

/** remark plugin: show raw HTML as literal text instead of dropping or rendering it. */
function remarkHtmlAsText() {
  return (tree: MdNode) => {
    const walk = (n: MdNode) => {
      if (n.type === "html") n.type = "text";
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/** A picture in the words: it opens the media viewer on itself; held by the hub, it waits for Show; gone, it is a link. */
function MdImage({ src, shown, alt }: { src: string; shown: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <ImageLink src={src} alt={alt} />;
  return (
    <PictureGate src={shown}>
      {(loaded, failed) => {
        const key = `md:${loaded}`;
        const open = (e: { preventDefault(): void }) => {
          // A picture inside a link opens here rather than following the link (the viewer links the original).
          e.preventDefault();
          openViewer(
            { kind: "list", items: [{ key, kind: "image", src: loaded, name: alt || undefined, download: imageDownload(src), original: /^https?:\/\//i.test(src.trim()) ? src.trim() : undefined }] },
            key,
          );
        };
        return (
          <button type="button" data-media-key={key} onClick={open} aria-label={alt || t("message.images.open")} className="my-2 inline-block max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-border align-top">
            <img src={loaded} alt={alt ?? ""} className="block max-h-96 max-w-full" loading="lazy" decoding="async" onError={() => void failed().then((held) => setBroken(!held))} />
          </button>
        );
      }}
    </PictureGate>
  );
}

/** A picture that cannot be shown here: a link to it. */
function ImageLink({ src, alt }: { src: string; alt?: string }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => openOutside(e, src)} className="inline-flex items-center gap-1">
      <ImageIcon className="inline size-4" />
      {alt || t("common.image")}
    </a>
  );
}

// Inside the iOS app, links that leave the hub open in Safari (openOutside); in a browser, in a new tab.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => openOutside(e, href)}>
      {children}
    </a>
  ),
  // The page CSP loads images from the hub only (img-src 'self' data: blob:): web images come through its proxy, which
  // fetches only what the hub decided to show. Anything else (another scheme, another hub route) stays a link.
  img: ({ src, alt }) => {
    const s = typeof src === "string" ? src : "";
    const shown = s ? mediaSrc(s) : undefined;
    return shown ? <MdImage src={s} shown={shown} alt={alt} /> : <ImageLink src={s} alt={alt} />;
  },
  pre: ({ children }) => (
    <div className="group relative">
      <pre>{children}</pre>
      <CopyButton text={textOf(children).replace(/\n$/, "")} label="" className="absolute top-1.5 right-1.5 bg-surface/80 opacity-0 transition group-hover:opacity-100 focus:opacity-100 mobile:opacity-100" />
    </div>
  ),
  input: ({ checked, type }) => (type === "checkbox" ? <input type="checkbox" checked={!!checked} readOnly disabled /> : null),
  // A secret the hub took out of the user's message (lib/user-markdown.ts).
  span: ({ className, children }) =>
    className === "vault-ref" ? (
      <span className="vault-ref">
        <Lock className="size-3" />
        {children}
      </span>
    ) : (
      <span className={className}>{children}</span>
    ),
};

const ASSISTANT_PLUGINS = [remarkGfm, remarkHtmlAsText];
const USER_PLUGINS = [remarkGfm, remarkHtmlAsText, remarkUserText];

/** `user`: what the user typed (line breaks kept, vault chips) rather than an agent's reply. */
export const Markdown = memo(function Markdown({ text, className, user }: { text: string; className?: string; user?: boolean }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown remarkPlugins={user ? USER_PLUGINS : ASSISTANT_PLUGINS} components={components} skipHtml={false}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
