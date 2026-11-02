// The page in the browser: hydrates what was prerendered for its language, then lets things arrive as they come into
// view.

import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { siteConfig, type Lang } from "../site.config";
import { App } from "./App";
import { PAGES, type Page } from "./pages";
import "./styles.css";

const lang = (siteConfig.languages as readonly string[]).includes(document.documentElement.lang) ? (document.documentElement.lang as Lang) : "en";
// prerender.mjs marks a page other than the landing one on <html data-page>.
const page = (PAGES as readonly string[]).includes(document.documentElement.dataset.page ?? "") ? (document.documentElement.dataset.page as Page) : "home";
const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App lang={lang} page={page} />
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
