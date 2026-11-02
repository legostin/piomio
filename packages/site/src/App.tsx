import type { Lang } from "../site.config";
import { LangContext, translator } from "./i18n";
import { Compare, Faq, Footer, HowItWorks, Install, Integrations, Iphone, Security } from "./sections/Sections";
import { Features } from "./sections/Features";
import { ServerGuide } from "./sections/ServerGuide";
import { Stage } from "./sections/Stage";
import { TopBar } from "./sections/TopBar";
import { DocsPage } from "./docs/DocsPage";
import { docHref, type DocPageData } from "./docs/page";
import { data } from "./data";
import type { Page } from "./pages";

export function App({ lang, page = "home", doc }: { lang: Lang; page?: Page; doc?: DocPageData }) {
  return (
    <LangContext.Provider value={{ lang, t: translator(lang) }}>
      <TopBar page={page} hrefFor={doc && ((l) => docHref(data.base, l, doc.prefix, doc.slug))} />
      <main>
        {page === "docs" && doc ? (
          <DocsPage data={doc} />
        ) : page === "server" ? (
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
