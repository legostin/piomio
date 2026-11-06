// Check the routes actually built from published release metadata, even in a checkout stamped for the next line.
import { loadDocs } from "./docs.mjs";

export function docsCheckPlan(published, languages) {
  const current = loadDocs({ languages, release: published.release?.version })[0];
  const slugs = current.nav.groups.flatMap((g) => g.pages);
  return {
    slugs,
    docLanguages: Object.entries(current.sourceLang).filter(([lang, from]) => lang === from).map(([lang]) => lang),
    routes: [...slugs.map((slug) => [slug, ""]), ["index", `${current.id}/`]],
  };
}
