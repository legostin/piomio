# Integrations

Everything Piomio connects to or knows how to do for a person (the weather, calendars, maps, currencies…) lives here,
one folder per integration. The hub loads every folder here as a built-in plugin and lists it in the Plugins catalog.
Adding one means working in its folder only: no changes to the hub, the web UI or the apps.

## Add one

```bash
npm run new:integration -- air-quality
```

That copies [`_template`](_template) (a complete integration: sunrise and sunset as a card in the chat, and a `sunrise` signal source) to
`integrations/air-quality/`. Then, in that folder:

1. `.piomio-plugin/plugin.json`: the catalog card (category, icon, one line, an example to try), the hosts it calls,
   its card kinds and settings.
2. `.piomio-plugin/locales/en.json` and `ru.json`: every text a person reads, in both languages.
3. `server/index.ts`: the tools agents call, and the signals that can start triggers (the template's `sunrise` is one; see
   "Signals" in the guide). `ui/src/index.tsx`: the card they show in the chat.
4. `test/air-quality.test.ts`: tests against a fake of the service.

```bash
npx vitest run integrations/air-quality
npm run typecheck
npm run build:ui-plugins
```

The full guide (manifest fields, tools, cards, secrets, tests) is [`_template/SKILL.md`](_template/SKILL.md). It is
also the `make-integration` skill the hub gives its agents: ask your assistant for an integration that does not exist
yet, and it builds one the same way in its workspace and installs it on your hub once you allow what it asks for.

Folders whose names start with `_` are not integrations.
