import { useEffect } from "react";
import { Route, Switch, useLocation, useSearch } from "wouter";
import { useStore } from "./lib/store";
import { agentPath } from "./lib/team";
import { conversations, init, phase, session, team } from "./state/app";
import { openPanel } from "./state/panel";
import { pluginLoad, useUiPlugins } from "./plugins/host";
import { matchRoute, type RouteEntry } from "./plugins/registry";
import { usePluginRegistry } from "./plugins/slots";
import { PluginBoundary } from "./plugins/boundary";
import { AuthScreen } from "./pages/Auth";
import { Layout, TopBar } from "./components/Layout";
import { Toasts } from "./components/Toasts";
import { MediaViewer } from "./components/viewer/MediaViewer";
import { FirstRunGate } from "./components/FirstRun";
import { Button, EmptyState } from "./components/ui";
import { OwlMark } from "./components/OwlMark";
import { sectionForPath, type PanelSection } from "./components/nav";
import { ChatPage } from "./pages/chat/ChatPage";
import { AgentPage } from "./pages/chat/AgentPage";
import { TaskDetailPage } from "./pages/TaskDetail";
import { ChannelPage } from "./pages/channels/ChannelPage";
import { entityPath } from "./state/ask";
import { MobileApp, useMobileReadyOnError } from "./pages/MobileApp";
import { mobileMode } from "./lib/mobile";
import { desktopApp, desktopInvoke } from "./lib/desktop";
import { t } from "./i18n";

export function App() {
  const p = useStore(phase);
  useEffect(() => {
    void init();
  }, []);
  useMobileReadyOnError(p.kind === "error");

  return (
    <>
      {(p.kind === "loading" || p.kind === "reauth") && (
        <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg" role="status">
          <OwlMark size={52} mood="sleepy" className="animate-zoom" />
          <span className="animate-fade text-sm text-muted">{t(p.kind === "loading" ? "app.connecting" : "app.reauth")}</span>
        </div>
      )}
      {p.kind === "error" && (
        <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-bg p-6">
          <EmptyState art={<OwlMark size={64} mood="asleep" />} title={t("app.hubUnavailable")} hint={p.message} />
          <Button variant="primary" onClick={() => void init()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {(p.kind === "setup" || p.kind === "login") && <AuthScreen mode={p.kind} auth={p.auth} />}
      {p.kind === "ready" && <FirstRunGate>{mobileMode ? <MobileApp /> : <ReadyApp />}</FirstRunGate>}
      {p.kind === "ready" && <MediaViewer />}
      <Toasts />
    </>
  );
}

function ReadyApp() {
  useUiPlugins();
  const [location] = useLocation();
  const { routes } = usePluginRegistry();
  const route = matchRoute(routes, location);
  if (route?.bare) return <BareRoute route={route} />;
  // The desktop app's Pio window shows nothing but a bare page: the rest of the app has no place in a bubble.
  if (overlayWindow) return <NoOverlay />;
  return (
    <Layout>
      <Routes />
    </Layout>
  );
}

const overlayWindow = !!desktopApp()?.pio;

/** A plugin's page drawn alone; in the desktop app's Pio window over a see-through background. */
function BareRoute({ route }: { route: RouteEntry }) {
  useEffect(() => {
    if (!overlayWindow) return;
    document.documentElement.classList.add("owl-overlay");
    return () => document.documentElement.classList.remove("owl-overlay");
  }, []);
  const C = route.component;
  return (
    <PluginBoundary key={route.key} pluginId={route.pluginId}>
      <C pluginId={route.pluginId} />
    </PluginBoundary>
  );
}

/** The Pio window with no page for it (the plugin is off): once the plugins have loaded, the app puts it away. */
function NoOverlay() {
  const s = useStore(session);
  const loads = useStore(pluginLoad);
  const settled = !!s && Object.keys(loads).length >= (s.uiPlugins ?? []).length && Object.values(loads).every((l) => l.status !== "loading");
  useEffect(() => {
    document.documentElement.classList.add("owl-overlay");
    if (!settled) return;
    const timer = setTimeout(() => void desktopInvoke("pio_hide").catch(() => {}), 1500);
    return () => clearTimeout(timer);
  }, [settled]);
  return null;
}

/** A former page URL: open its panel section over the default agent's dialog (keeping the query, e.g. /tasks?new=1). */
function OpenSection({ section }: { section: PanelSection }) {
  const [, navigate] = useLocation();
  const search = useSearch();
  useEffect(() => {
    openPanel(section);
    navigate(search ? `/?${search}` : "/", { replace: true });
  }, [section, search, navigate]);
  return <AgentPage />;
}

/** /chat/:id: an agent's dialog moves to its own address; older chats still open here. */
function ChatRoute({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const s = useStore(session);
  const convs = useStore(conversations);
  const members = useStore(team);
  const conv = convs.find((c) => c.id === id);
  const dialogOf = conv?.kind === "main" ? conv.agentId : members?.find((m) => m.conversationId === id)?.agentId;
  // A new agent's setup chat that made the agent becomes its dialog.
  const becameAgent = conv?.kind === "setup" && conv.purpose === "agent" ? entityPath(conv, s?.defaultAgent) : undefined;
  useEffect(() => {
    if (dialogOf) navigate(agentPath(dialogOf, s?.defaultAgent), { replace: true });
    else if (becameAgent) navigate(becameAgent, { replace: true });
  }, [dialogOf, becameAgent, s?.defaultAgent, navigate]);
  return dialogOf || becameAgent ? null : <ChatPage conversationId={id} />;
}

function Routes() {
  const [location] = useLocation();
  const { routes } = usePluginRegistry();
  const pluginRoute = matchRoute(routes, location);
  if (pluginRoute) {
    // Pages plugins put in the navigation open in the settings panel; other plugin routes are full views.
    const navRoute = routes.find((r) => r.key === pluginRoute.key && r.nav && !r.path.includes(":"));
    if (navRoute) return <OpenSection section={`plugin:${navRoute.key}`} />;
    const C = pluginRoute.component;
    return (
      <>
        <TopBar>
          <span className="truncate text-[15px] font-semibold">{routes.find((r) => r.key === pluginRoute.key)?.title}</span>
        </TopBar>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PluginBoundary key={pluginRoute.key} pluginId={pluginRoute.pluginId}>
            <C pluginId={pluginRoute.pluginId} />
          </PluginBoundary>
        </div>
      </>
    );
  }
  const section = sectionForPath(location);
  if (section) return <OpenSection section={section} />;
  return (
    <Switch>
      <Route path="/">{() => <AgentPage />}</Route>
      <Route path="/agent/:id">{(params) => <AgentPage key={params.id} agentId={params.id} />}</Route>
      <Route path="/chat/:id">{(params) => <ChatRoute id={params.id} />}</Route>
      <Route path="/tasks/:id">{(params) => <TaskDetailPage id={params.id} />}</Route>
      <Route path="/channels/:id">{(params) => <ChannelPage key={params.id} id={params.id} />}</Route>
      <Route>
        <TopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState icon="compass" title={t("app.notFound")} hint={t("app.notFoundHint")} />
        </div>
      </Route>
    </Switch>
  );
}
