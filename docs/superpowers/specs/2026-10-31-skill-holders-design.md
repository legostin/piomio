# Skills of their own: each teammate has the skills that fit its role

Approved by the person on 2026-10-31. A skill belongs to the teammates it was given to, not to the whole team: the
researcher has the research skills, the SMM agent the ones for running pages. Choices made: a new skill the person
teaches goes to the agent who learned it; skills from plugins and the built-in ones stay the whole team's until
someone gives them to particular agents; who has a skill is set in the chat ("дай SMM скилл постинга").

## How it feels

- **Teaching.** The person teaches the SMM agent to post on a site; the agent saves the skill (`hub_skill_save`, the
  same card) and says in a sentence that the skill is its own and it can give it to a teammate too.
- **Giving.** "Пусть это умеет ещё Исследователь", "скилл X только для SMM", "отдай всем": any agent changes who has a
  skill with `hub_skill_assign`. When it is unclear whom to give it to, it asks with quick replies (team members and
  "Всем").
- **Routing.** The assistant sees in its team list which teammate has which skill of its own, so a request that needs
  the posting skill goes to SMM (`task_delegate` / `team_message`) without the person naming it.
- **Not having it.** An agent lists only its own skills; `skill_load` of a teammate's skill refuses and names who has
  it ("ask them with team_message or hand them the work with task_delegate").
- **Web.** The Skills page shows who has each skill: avatars and names, or "Вся команда"; a button opens the
  assistant's chat with "Хочу решить, у кого будет скилл X". An agent's card shows the skills of its own.

## Hub side

**Who has a skill** (`packages/core/src/skills.ts`)
- Table `skill_agents(skill text primary key, agents text not null)` (JSON list of agent ids), replicated with the
  cluster (`MAIN_TABLES`). No row = the whole team.
- `SkillHolders` over it: `get(name)`, `all()`, `set(name, agents)` (an empty list deletes the row),
  `dropAgent(id)` (removes the agent from every list; a list left empty deletes the row, so the skill goes back to
  the whole team instead of to nobody), `dropSkill(name)`.
- Rule `hasSkill(agent, skill, holders)`: the skill matches the agent's `skills` globs (unchanged, an advanced filter,
  default `*`) and it has no holders or the agent is one of them.
- `SkillIndex.forAgent(agent, also?)` applies the rule (the index gets the holders from the hub); `also` is a skill
  the session follows anyway (a trigger's run of a skill: the person chose it when setting the trigger up).

**Sessions** (`runner.ts`, `prompt.ts`)
- The skills listed in the prompt and copied for Claude Code / Codex are the agent's own (`forAgent`).
- The dialog's team list adds each teammate's own skills (ones given to it, not the whole team's):
  `- smm: SMM — … (skills: insta-post, vk-post; brains: …)`.

**Tools**
- `skill_load` refuses a skill the calling agent does not have, naming who has it.
- `hub_skills_list` (read): every skill with description, source, taught, and who has it (`"team"` or agent ids).
- `hub_skill_assign {name, agents}` (local-write): sets who has the skill; `[]` = the whole team; unknown agents or
  skill refuse with the lists to pick from. Audited (`skill.assign`).
- `hub_agents_list` adds each agent's own skills.
- `hub_skill_save`: a new taught skill is given to the saving agent; an update (`replaces`) keeps the old one's
  holders. The result tells the agent it is its own and how to give it to others. `hub_skill_delete` drops its row.
- Removing an agent (`Hub.removeAgent`) drops it from the holders when it is gone (a built-in one only returns to its
  defaults and keeps its skills).

**API / web**
- `GET /api/skills` adds `agents: string[]` (empty = whole team).
- Skills page: holders per skill (avatars + names / "Вся команда") and the button to the chat (`askInChat`).
- Agents page: chips with each agent's own skills. The editor's "Skills" patterns field stays under "More settings".
- Strings in `packages/web/src/i18n/{en,ru}.ts`; hub strings (if any) in `packages/core/src/locales`.

## Not in this change

- An iOS screen for it: the chat does it there.
- Plugins in the Claude Code format passed with `--plugin-dir` still bring their own skills to Claude Code natively,
  whoever has them in the hub; the hub's list and `skill_load` follow the holders.

## Testing

- Unit: `SkillHolders` (set, clear, drop agent → whole team), `hasSkill` / `forAgent` with globs, holders and `also`.
- Tools: `hub_skill_assign` (sets, clears, refuses unknown names), `skill_load` refusal, `hub_skill_save` gives the
  new skill to its agent and an update keeps holders.
- Prompt: the team list shows a teammate's own skills; the Skills section lists only the agent's.
- `i18n.test.ts` parity; typecheck; a throwaway hub: assign in the chat, see it on the Skills page.
