// The site's pages: the landing page (/<lang>/), the server guide (/<lang>/server/) and the docs (/<lang>/docs/…, made
// from docs/guide by scripts/docs.mjs; PAGES lists only the fixed ones).

export type Page = "home" | "server" | "docs";
export const PAGES: readonly Page[] = ["home", "server"];

/** A fixed page's address under its language, without the base: "" or "server/". */
export const pagePath = (page: Page) => (page === "home" ? "" : `${page}/`);
