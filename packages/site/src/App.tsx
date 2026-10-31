import type { Lang } from "../site.config";
import { LangContext, translator } from "./i18n";
import { Footer, HowItWorks, Install, Integrations, Iphone, Security } from "./sections/Sections";
import { Features } from "./sections/Features";
import { Stage } from "./sections/Stage";
import { TopBar } from "./sections/TopBar";

export function App({ lang }: { lang: Lang }) {
  return (
    <LangContext.Provider value={{ lang, t: translator(lang) }}>
      <TopBar />
      <main>
        <Stage />
        <Features />
        <HowItWorks />
        <Security />
        <Integrations />
        <Iphone />
        <Install />
      </main>
      <Footer />
    </LangContext.Provider>
  );
}
