// A channel: its posts newest first under their day, like a channel in a messenger, with the editor gathering in the
// background. The header says who edits it and when; "refresh" gathers now; "settings" opens the editor's chat, where
// the channel's card has its buttons.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { RotateCw, SlidersHorizontal } from "lucide-react";
import type { FeedPost } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { formatTime } from "../../lib/format";
import { cadenceOf, dayKey } from "../../lib/feeds";
import { mediaSrc } from "../../lib/media";
import { QuietImg } from "../../components/picture";
import { agents, ensureAgents } from "../../state/app";
import { ensureFeeds, feedPosts, feeds, loadPosts, markFeedRead, runFeed } from "../../state/feeds";
import { askInChat } from "../../state/ask";
import { toast } from "../../state/toast";
import { Markdown } from "../../components/markdown";
import { Button, EmptyState, IconButton, Loading } from "../../components/ui";
import { ChannelTile } from "./ChannelTile";
import { TopBar } from "../../components/Layout";
import { formatDate, t } from "../../i18n";

const CADENCE_LABEL = {
  morning: "channel.cadence.morning",
  twice: "channel.cadence.twice",
  thrice: "channel.cadence.thrice",
  weekly: "channel.cadence.weekly",
} as const;

/** One news item: its picture, the title (the link), the gist, the source and the time. */
export function PostCard({ post }: { post: FeedPost }) {
  const img = post.image ? mediaSrc(post.image) : undefined;
  // Held by the hub (its address could carry data out) or gone: the post goes on without it.
  const [noImg, setNoImg] = useState(false);
  return (
    <article className="overflow-hidden rounded-[22px] border border-hairline bg-surface shadow-card">
      {img && !noImg && (
        <a href={post.url ?? post.image} target="_blank" rel="noopener noreferrer" className="group block overflow-hidden">
          <QuietImg src={img} alt="" loading="lazy" onFail={() => setNoImg(true)} className="aspect-[16/9] w-full bg-surface-2 object-cover transition-transform duration-500 ease-out group-hover:scale-[1.02]" />
        </a>
      )}
      <div className="min-w-0 px-4 pt-3.5 pb-3">
        <h3 className="text-[16px] leading-snug font-semibold text-balance">
          {post.url ? (
            <a href={post.url} target="_blank" rel="noopener noreferrer" className="decoration-accent decoration-2 underline-offset-4 hover:underline">
              {post.title}
            </a>
          ) : (
            post.title
          )}
        </h3>
        <Markdown text={post.text} className="mt-1.5 text-[14px] text-fg/80" />
        <div className="mt-2 text-xs font-medium text-muted">
          {post.source ? `${post.source} · ` : ""}
          {formatTime(post.createdAt)}
        </div>
      </div>
    </article>
  );
}

export function ChannelPage({ id }: { id: string }) {
  const list = useStore(feeds);
  const all = useStore(feedPosts);
  const team = useStore(agents);
  const [, navigate] = useLocation();
  const [more, setMore] = useState(false);
  const feed = list?.find((f) => f.id === id);
  const page = all[id];
  useEffect(() => {
    ensureFeeds();
    ensureAgents();
  }, []);
  useEffect(() => {
    loadPosts(id).catch((e) => toast(errorText(e), "error"));
  }, [id]);
  // Open is read: what came while it was open too.
  useEffect(() => {
    if (feed?.unread) void markFeedRead(id);
  }, [id, feed?.unread]);

  const days = useMemo(() => {
    const out: Array<{ key: string; posts: FeedPost[] }> = [];
    for (const p of page?.posts ?? []) {
      const key = dayKey(p.createdAt);
      if (out[out.length - 1]?.key !== key) out.push({ key, posts: [] });
      out[out.length - 1].posts.push(p);
    }
    return out;
  }, [page?.posts]);

  if (list && !feed) {
    return (
      <>
        <TopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon="newspaper" title={t("channel.notFound")} />
        </div>
      </>
    );
  }

  const running = !!feed?.runningTaskId;
  const editor = team?.find((a) => a.id === feed?.agentId)?.name ?? feed?.agentId;
  const cadence = feed ? cadenceOf(feed) : undefined;
  const when = feed ? (feed.enabled ? (cadence ? t(CADENCE_LABEL[cadence]) : feed.times.join(", ")) : t("channel.paused")) : "";
  const refresh = async () => {
    try {
      await runFeed(id);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <>
      <TopBar>
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1">
          {feed && <ChannelTile feedId={feed.id} size={28} running={running} paused={!feed.enabled} />}
          <div className="min-w-0">
            <div className="truncate text-[14.5px] leading-tight font-semibold">{feed?.title ?? ""}</div>
            {feed && <div className="truncate text-[11.5px] leading-tight text-muted">{t("channel.byline", { editor: editor ?? "", when })}</div>}
          </div>
        </div>
        {feed && (
          <>
            <IconButton label={running ? t("channel.gathering") : t("channel.refresh")} onClick={() => void refresh()} disabled={running} className="size-8">
              <RotateCw className={running ? "size-[17px] animate-spin" : "size-[17px]"} />
            </IconButton>
            <IconButton
              label={t("channel.settings")}
              className="size-8"
              onClick={() =>
                feed.chatId ? navigate(`/chat/${encodeURIComponent(feed.chatId)}`) : askInChat(feed.agentId, t("channel.settingsRequest", { title: feed.title }), navigate).catch((e) => toast(errorText(e), "error"))
              }
            >
              <SlidersHorizontal className="size-[17px]" />
            </IconButton>
          </>
        )}
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-xl px-4 pt-3 pb-12">
          {!page && <Loading />}
          {page && running && (
            <div className="animate-in mx-auto mt-2 flex w-fit items-center gap-2 rounded-full bg-accent-soft px-3.5 py-1.5 text-[13px] font-medium text-accent-text">
              <span className="live-dot size-2 rounded-full" />
              {page.posts.length ? t("channel.gathering") : t("channel.gatheringFirst")}
            </div>
          )}
          {page && !page.posts.length && !running && <EmptyState icon="newspaper" title={t("channel.noPosts")} />}
          {days.map((d) => (
            <section key={d.key}>
              <h2 className="sticky top-2 z-[1] flex justify-center pt-4 pb-3">
                <span className="glass day-chip shadow-card">{formatDate(d.posts[0].createdAt, { weekday: "long", day: "numeric", month: "long" })}</span>
              </h2>
              <div className="flex flex-col gap-4">
                {d.posts.map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </div>
            </section>
          ))}
          {page && !page.done && page.posts.length > 0 && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                loading={more}
                onClick={() => {
                  setMore(true);
                  loadPosts(id, true)
                    .catch((e) => toast(errorText(e), "error"))
                    .finally(() => setMore(false));
                }}
              >
                {t("channel.more")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
