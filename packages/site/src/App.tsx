import type { Lang } from "../site.config";
import { LangContext, translator } from "./i18n";
import { Compare, Faq, Footer, HowItWorks, Install, Integrations, Iphone, Security } from "./sections/Sections";
import { Features } from "./sections/Features";
import { ServerGuide } from "./sections/ServerGuide";
import { Stage } from "./sections/Stage";
import { TopBar } from "./sections/TopBar";
import type { Page } from "./pages";

export function App({ lang, page = "home" }: { lang: Lang; page?: Page }) {
  return (
    <LangContext.Provider value={{ lang, t: translator(lang) }}>
      <TopBar page={page} />
      <main>
        {page === "server" ? (
          <ServerGuide />
        ) : (
          <>
            <Stage />
            <Features />
            <HowItWorks />
            <Compare />
            <Security />
            <Integrations />
            <Iphone />
            <Faq />
            <Install />
          </>
        )}
      </main>
      <Footer />
    </LangContext.Provider>
  );
}
