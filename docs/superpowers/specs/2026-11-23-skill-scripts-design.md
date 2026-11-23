# Scripts for taught skills

The person, 2026-11-23: "когда мы работаем с браузером и учим навыку, агент всегда просто ручками всё делает — круто
будет, если он сможет что-то автоматизировать скриптом, например часть работы своей, и включаться только если что-то
пошло не так, и улучшать скрипт". And, the same day: give agents the browser's traffic (see, record, intercept,
change), as a plugin. These are two pieces of work; this spec is the first. The second gets its own spec and PR
("Next: traffic" at the end holds what was decided for it).

## What the code does today

- A taught skill is `SKILL.md` (instructions) plus the recording's files in `<dataDir>/skills/<name>/`
  (`taught-skills.ts`, `hub_skill_save` on the person's card). Running it is the model calling `browser_snapshot`,
  `browser_click`, `browser_type`… one call per step, every run, forever: a ten-step order costs ten model turns with
  the whole context each time (see the cost-of-autonomy notes).
- Triggers already have scripts: JavaScript in QuickJS on a worker thread (`signals/sandbox.ts`), reaching the hub only
  through `pio.*` host calls. Browser tools are closed to them (`TRIGGER_CLOSED_PREFIXES`).
- Every browser action is guarded where it runs: `browser_click` refuses controls with consequences, `browser_submit`
  goes through the policy (a pre-approved rule of the skill, the person's words, or a card), addresses opened after
  outside content go through the egress guard. All of it sits in `ToolGateway.call`.

## Decided (the person's answers, 2026-11-23)

- **A script is JavaScript in the hub's sandbox**, not a list of steps: loops, conditions, data from many pages.
- **The agent always runs it**: also on a schedule the agent wakes, runs the script with one tool call, reads the
  result and answers in its own words. No model-free path.
- **The agent fixes the script by itself**: saving a new version of a script needs no card as long as the skill's
  sites and pre-approved clicks stay what the person approved. The previous version is kept.

## Design

### The script

`<dataDir>/skills/<name>/script.js` (TypeScript syntax is stripped, as for triggers; at most 64 KB), beside `SKILL.md`.
The previous version is `script.prev.js`. `SKILL.md` stays the truth about what the task is; the script is the fast
way through its mechanical part.

```js
export default async function ({ quantity = 2 }, browser) {
  await browser.open("https://5vodi.kz/catalog");
  await browser.click({ role: "link", name: "Вода 19 л" });
  await browser.type({ role: "textbox", name: "Количество" }, String(quantity));
  const total = /Итого:\s*([\d\s]+)/.exec(await browser.text())?.[1];
  await browser.submit({ role: "button", name: "Оформить заказ*" }, { description: `Заказ ${quantity} бутылей`, amount: Number(total.replace(/\s/g, "")), currency: "KZT" });
  return { total };
}
```

`browser` is the agent's own browser tools, called by the hub instead of the model:

| Script | Tool |
| --- | --- |
| `open(url)` | `browser_open`; the address must be on one of the skill's `sites` |
| `click(t)`, `type(t, text)`, `press(key, t?)`, `scroll(…)`, `back()`, `wait({text, ms})` | the same-named tools |
| `text({maxChars})` → string, `page()` → `{url, title}` | `browser_get_text`, `browser_snapshot` |
| `find({role, name})` → `[{ref, role, name, value, href, checked, disabled, submit}]` | `browser_snapshot` |
| `submit(t, {description, amount, currency})` | `browser_submit` (label and url filled in by the hub) |
| `upload(t, files, description)`, `fillSecret(t, vaultRef, field)`, `download(t or {url})` | the same-named tools; a `url` must be on the skill's sites |
| `log(…)` | kept with the run's result |

A target `t` is a ref (`"e12"`) or `{role?, name, nth?}`: the element's name as `browser_snapshot` shows it, compared
without case and extra spaces; `*` stands for any run of characters ("Оплатить * ₸"). The hub finds it on the whole
page (not only near the viewport), waiting up to 8 s for it to appear; none, or several without `nth`, is an error
that names what is there.

### How a run goes: `skill_run {name, input}`

A core tool beside `skill_load`. It takes a taught skill the agent has, runs its script in a sandbox of the skill
scripts' own (10 min wall, 300 calls; trigger scripts keep theirs), and maps every `browser.*` call to
`ToolGateway.call` **under the calling session**. So each step is audited and decided exactly as if the model had
made it: the click guard, the skill's pre-approved limits, the person's card for anything else, taint and the egress
guard. A script can do nothing the agent could not do by hand in that chat or task.

- Success: `Result:` the returned JSON (cut at 20 KB), the log, how long it took. It is page content: untrusted.
- A step fails (element gone, check thrown by the script, a refusal): the run stops. The result names the call and
  its error, lists the calls made before it, includes the script with line numbers, and says: the browser is where
  the script left it; finish the task by hand from here, then save a fixed script.
- A step waits for the person (a card not answered in time) or the person declines: the run stops there, nothing
  after it runs, and the result says so. A script cannot go on past a card.
- The person takes control mid-run: the browser tools already wait and then report what the person did.

`skill_run` is `local-write` and joins `SKILL_RUN_TOOLS`, so a scheduled run of a taught skill may call it.

### Writing and fixing: `skill_script_save {name, script, note}` / `{name, restore: true}`

- With a new skill: `hub_skill_save` takes an optional `script`; the card says the skill comes with a script. An
  update (`replaces`) without `script` keeps the one it has.
- Later: `skill_script_save` writes `script.js` of a taught skill the agent has, keeping the old one as
  `script.prev.js`; `restore` swaps them back. No card, also in a session that has read the web (a repair always
  has): the script reaches nothing new. Its `open` is held to the skill's sites, every call is still decided by the
  policy at run time, and the pre-approvals and sites change only through `hub_skill_save`'s card. Each save is in the
  audit log with its `note`, and the agent says in one line what it changed.
- The script is compiled before it is saved; a syntax error saves nothing.
- `skill_load` adds a line when a skill has a script (run it with `skill_run`; `script: true` returns its text).

### The agent's instructions

`plugins/browser/skills/teach-by-demo/SKILL.md` gains a section: when a script is worth writing (the steps are the
same each time; write it after one run by hand has proven them), the API above, "run the script first, step in only
where it stops, then fix it", and what stays by hand (captchas, anything the person must decide).

### Browser plugin

`browser_snapshot` gains `role`, `name` (narrow the list to matching elements anywhere on the page) and `json`
(the list as JSON with the page's url and title). Nothing else changes there; no new browser tool.

### Sandbox

`ScriptSandbox.run` takes the script's kind: a trigger's (`pio`, a verdict back) or a skill's (`browser`, any JSON
back). The worker's prelude builds the second argument from it. Limits, memory and thread handling are shared code.

## Testing

- Sandbox: a skill script gets `browser`, returns JSON, has no `pio`; a trigger script is unchanged.
- Runner (fake gateway): target lookup and waiting, `open` outside the sites, an error stops the run with its trace,
  an unanswered card stops it for good, the result's size caps.
- Taught skills: save with a script, replace keeps it, `skill_script_save` and `restore`, a syntax error, a skill the
  agent does not have.
- Policy: `skill_run` in a background skill run; `skill_script_save` asks nobody in a tainted session.
- Browser plugin: snapshot by role and name, `*`, JSON.
- A live check on a throwaway hub: teach a small task, run it by script, break the page, repair.

## Docs

`docs/guide/{en,ru}/browser.md`: scripts in the "teaching" part, in both languages, in the same commit.

## Next: traffic (its own spec)

Decided: an ability of its own in the Plugins catalog, off by default. Reading and recording requests, blocking
them and replacing responses is the agent's to do; changing an outgoing request or sending one of its own that is
not a GET is an action with consequences (a card, or a rule the person pre-approved). Cookies, tokens and passwords
in headers and bodies never reach the model. Scripts then get `browser.requests()` to read a site's API answers
instead of scraping the page.
