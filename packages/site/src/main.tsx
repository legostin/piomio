// The page in the browser: hydrates what was prerendered for its language, then lets things arrive as they come into
// view.

import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import type { DocPageData } from "./docs/page";
import { PAGES, type Page } from "./pages";
import "./styles.css";

const lang = (siteConfig.languages as readonly string[]).includes(document.documentElement.lang) ? (document.documentElement.lang as Lang) : "en";
// prerender.mjs marks a page other than the landing one on <html data-page>; a docs page also carries what it was made
// from (#doc-data), so it renders here the same as it was prerendered.
const marked = document.documentElement.dataset.page ?? "";
const docData = document.getElementById("doc-data")?.textContent;
const doc = marked === "docs" && docData ? (JSON.parse(docData) as DocPageData) : undefined;
const page: Page = doc ? "docs" : (PAGES as readonly string[]).includes(marked) ? (marked as Page) : "home";
const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App lang={lang} page={page} doc={doc} />
  </StrictMode>
);
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);

// Reveal on scroll (the page is prerendered visible; the inline script in <head> adds .js, which turns the effect on).
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
);
for (const el of document.querySelectorAll(".reveal")) io.observe(el);
