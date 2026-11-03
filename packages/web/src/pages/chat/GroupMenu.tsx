// A group chat's menu (a right click on its row, a long press on a touch screen, "⋯" on hover) and what follows it:
// its settings, the confirmation before deleting, and the bar an archived group's chat shows instead of the composer.

import { useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Archive, ArchiveRestore, CheckCheck, MessageSquareDot, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Conversation, GroupChat } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { chatForPath, groupMenuActions, type GroupMenuAction } from "../../lib/team";
import type { MenuAnchor } from "../../lib/menu";
import { conversations, groups, markRead, markUnread } from "../../state/app";
import { archiveGroup, deleteGroup } from "../../state/groupActions";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { Button, Modal } from "../../components/ui";
import { t, type MessageKey } from "../../i18n";
import { RestoreBar, run } from "./AgentMenu";
import { GroupDialog } from "./GroupDialog";

const ICONS: Record<GroupMenuAction, ReactNode> = {
  unread: <MessageSquareDot className="size-4" />,
  read: <CheckCheck className="size-4" />,
  settings: <SlidersHorizontal className="size-4" />,
  archive: <Archive className="size-4" />,
  restore: <ArchiveRestore className="size-4" />,
  delete: <Trash2 className="size-4" />,
};

const LABELS: Record<GroupMenuAction, MessageKey> = {
  unread: "agentMenu.markUnread",
  read: "agentMenu.markRead",
  settings: "group.settings",
  archive: "agentMenu.archive",
  restore: "agentMenu.restore",
  delete: "agentMenu.delete",
};

/** The group as its settings form takes it: the conversation when the list has it. */
function asConversation(g: GroupChat, list: Conversation[]): Conversation {
  return list.find((c) => c.id === g.conversationId) ?? { id: g.conversationId, kind: "group", title: g.title, agentId: g.members[0], members: g.members, createdAt: g.lastActivityAt, updatedAt: g.lastActivityAt };
}

export interface GroupMenuApi {
  /** Opens the group's menu at a point or under a box. */
  open: (conversationId: string, anchor: MenuAnchor) => void;
  /** "⋯": opens it, or closes it when it is open for this group. */
  toggle: (conversationId: string, anchor: MenuAnchor) => void;
  /** The group whose menu is open. */
  openFor?: string;
  /** The menu and its dialogs: render once. */
  element: ReactNode;
}

/** One group menu with its dialogs for the list of groups (its settings open over the list, like "New group"). */
export function useGroupMenu(): GroupMenuApi {
  const groupList = useStore(groups);
  const convs = useStore(conversations);
  const [loc, navigate] = useLocation();
  const [menu, setMenu] = useState<{ conversationId: string; anchor: MenuAnchor } | null>(null);
  const [editing, setEditing] = useState<Conversation>();
  const [deleting, setDeleting] = useState<GroupChat>();

  const group = menu ? groupList?.find((g) => g.conversationId === menu.conversationId) : undefined;

  const act = (action: GroupMenuAction, g: GroupChat) => {
    switch (action) {
      case "unread":
        return void run(markUnread(g.conversationId));
      case "read":
        return void markRead(g.conversationId);
      case "settings":
        return setEditing(asConversation(g, convs));
      case "archive":
        return void run(archiveGroup(g.conversationId, true), t("groupMenu.archived", { title: g.title }));
      case "restore":
        return void run(archiveGroup(g.conversationId, false), t("groupMenu.restored", { title: g.title }));
      case "delete":
        return setDeleting(g);
    }
  };

  const items: MenuItem[] = group
    ? groupMenuActions({ archived: group.archived, unread: group.unread, hasMessages: !!group.lastMessage }).map((action) => ({
        id: action,
        label: t(LABELS[action]),
        icon: ICONS[action],
        danger: action === "delete",
        divider: action === "archive" || (action === "delete" && !!group.archived),
        onSelect: () => act(action, group),
      }))
    : [];

  const confirmDelete = async (archiveInstead: boolean) => {
    if (!deleting) return;
    const g = deleting;
    // Its chat, if on screen, gives way to the default agent's before the list forgets it.
    const leave = () => chatForPath(loc) === g.conversationId && navigate("/");
    const ok = archiveInstead
      ? await run(archiveGroup(g.conversationId, true), t("groupMenu.archived", { title: g.title }))
      : await run(deleteGroup(g.conversationId, leave), t("groupMenu.deleted", { title: g.title }));
    if (ok) setDeleting(undefined);
  };

  const element = (
    <>
      {menu && group && <ContextMenu key={group.conversationId} anchor={menu.anchor} items={items} label={group.title} onClose={() => setMenu(null)} />}
      <GroupDialog open={!!editing} onClose={() => setEditing(undefined)} group={editing} />
      <DeleteGroupDialog group={deleting} onConfirm={confirmDelete} onClose={() => setDeleting(undefined)} />
    </>
  );

  return {
    open: (conversationId, anchor) => setMenu({ conversationId, anchor }),
    toggle: (conversationId, anchor) => setMenu((m) => (m?.conversationId === conversationId ? null : { conversationId, anchor })),
    openFor: menu?.conversationId,
    element,
  };
}

/** "Delete <title>?": the chat and its messages go for good; the archive keeps them. */
function DeleteGroupDialog({ group, onConfirm, onClose }: { group?: GroupChat; onConfirm: (archiveInstead: boolean) => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState<"delete" | "archive">();
  const go = async (what: "delete" | "archive") => {
    setBusy(what);
    try {
      await onConfirm(what === "archive");
    } finally {
      setBusy(undefined);
    }
  };
  const archived = !!group?.archived;
  return (
    <Modal
      open={!!group}
      onClose={onClose}
      title={group ? t("groupMenu.deleteTitle", { title: group.title }) : ""}
      footer={
        <>
          {!archived && (
            <Button variant="ghost" className="mr-auto" disabled={!!busy} loading={busy === "archive"} onClick={() => void go("archive")}>
              {t("agentMenu.archiveInstead")}
            </Button>
          )}
          <Button onClick={onClose} disabled={!!busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={!!busy} loading={busy === "delete"} onClick={() => void go("delete")}>
            {t("agentMenu.delete")}
          </Button>
        </>
      }
    >
      {group && <p className="text-sm">{t(archived ? "groupMenu.deleteTextArchived" : "groupMenu.deleteText")}</p>}
    </Modal>
  );
}

/** Instead of the composer in an archived group chat: nobody writes there until it comes back. */
export function GroupArchivedBar({ group }: { group: Pick<GroupChat, "conversationId" | "title"> }) {
  return (
    <RestoreBar
      text={t("group.archivedBar", { title: group.title })}
      onRestore={() => run(archiveGroup(group.conversationId, false), t("groupMenu.restored", { title: group.title }))}
    />
  );
}
