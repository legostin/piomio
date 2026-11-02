// The site's pages: the landing page (/<lang>/) and the server guide (/<lang>/server/).

export type Page = "home" | "server";
export const PAGES: readonly Page[] = ["home", "server"];

/** A page's address under its language, without the base: "" or "server/". */
export const pagePath = (page: Page) => (page === "home" ? "" : `${page}/`);
