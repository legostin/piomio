// What "@piomio/shared" means to the web app's type checker (tsconfig "paths"): types only.
// The package root also re-exports Node-only modules, so browser code takes runtime values from
// "@piomio/shared/i18n", "@piomio/shared/avatar", "@piomio/shared/group", "@piomio/shared/thinking" and "@piomio/shared/commands" and nothing else from the shared package.
export type * from "../../shared/src/types.ts";
export type * from "../../shared/src/i18n.ts";
export type * from "../../shared/src/avatar.ts";
export type * from "../../shared/src/group.ts";
export type * from "../../shared/src/thinking.ts";
export type * from "../../shared/src/commands.ts";
