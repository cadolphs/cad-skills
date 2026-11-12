# cad-skills

Agent skills and the CLIs behind them, run straight from GitHub. Nothing to
install, no npm publish. Node 20+ and an authenticated `gh`.

```sh
npx github:cadolphs/cad-skills                 # skills and their commands
npx github:cadolphs/cad-skills board help
```

## Planning board

A GitHub project used for developing product ideas, not for tracking issues.
Ideas are draft items that move through Proposed, Exploring, Decided, In
progress, and Done. The item body holds the goal, open questions, decisions,
and spec, so it works as memory between agent sessions.

### Set it up in a repo

From the repo root, with a `gh` token that has the `project` scope
(`gh auth refresh -s project`):

```sh
npx github:cadolphs/cad-skills board init
```

This creates a project for the repo owner, sets the stages, describes the
project, links it to the repo, and writes:

- `.github/board.json`: which project the CLI talks to
- `.claude/skills/planning-board/SKILL.md`: when agents read and write the board
- `docs/planning-board.md`: stages, item shape, rules
- a pointer line in `AGENTS.md`, when that file exists

Options: `--project <number>` uses an existing project, `--owner <login>` puts
it under an organization, `--title <title>` names a new project, `--force`
overwrites files that differ. Running it again changes nothing that is already
in place. It refuses to replace the stages of a board that has items.

One step is manual, because GitHub has no API for it: in the project, add a
view with the Board layout.

### Use it

```sh
npx github:cadolphs/cad-skills board list [--status Exploring]
npx github:cadolphs/cad-skills board show <item>
npx github:cadolphs/cad-skills board add "<idea>" --body-file <path>
npx github:cadolphs/cad-skills board body <item> --body-file <path>
npx github:cadolphs/cad-skills board move <item> <status>
npx github:cadolphs/cad-skills board statuses
```

`<item>` is the number from `list` or a unique part of the title. `--json`
gives JSON.

Two moves carry rules. A move to Decided needs `--maintainer-said "<words>"`
and records them under `## Decisions`. A move to In progress needs
`--issue <n>[,<n>]` and lists the issues under `## Issues`. Stage names are
read from GitHub; if you rename one of those two, name it in
`.github/board.json`:

```json
{
  "owner": "cadolphs",
  "project": 4,
  "stages": { "decided": "Agreed", "inProgress": "Building" }
}
```

## Development

```sh
npm test
```

`skills/planning-board/board.mjs` is pure logic, `github.mjs` is the only file
that calls `gh`, and `cli.mjs` wires them to the file system.
