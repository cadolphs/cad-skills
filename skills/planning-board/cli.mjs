// planning board CLI: commands and the file/GitHub wiring around board.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_STAGES,
  addAgentsPointer,
  applyEdits,
  fillTemplate,
  findItem,
  findStatus,
  moveRequirements,
  parseArgs,
  parseConfig,
  planFiles,
  planStages,
  sortByStage,
  toItem,
} from './board.mjs';
import {
  addDraft,
  createGh,
  createProject,
  currentRepo,
  describeProject,
  fetchProject,
  linkRepo,
  replaceStages,
  setDraftBody,
  setStatus,
} from './github.mjs';

const CLI = 'npx github:cadolphs/cad-skills board';
const CONFIG_PATH = path.join('.github', 'board.json');
const templatesDir = path.join(import.meta.dirname, 'templates');

const readIfExists = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined;

const loadConfig = (cwd) => {
  const text = readIfExists(path.join(cwd, CONFIG_PATH));
  if (text === undefined) {
    throw new Error(`no ${CONFIG_PATH} here. Run: ${CLI} init`);
  }
  const { config, error } = parseConfig(text);
  if (error) throw new Error(error);
  return config;
};

const loadBoard = (gh, config) => {
  const project = fetchProject(gh, config.owner, config.project);
  if (!project.field?.options) {
    throw new Error('the project has no single-select "Status" field');
  }
  return {
    id: project.id,
    url: project.url,
    fieldId: project.field.id,
    options: project.field.options,
    items: sortByStage(project.nodes.map(toItem), project.field.options),
  };
};

const statusNames = (board) => board.options.map((option) => option.name).join(', ');

const requireStatus = (board, name) => {
  const option = typeof name === 'string' ? findStatus(board.options, name) : undefined;
  if (!option) {
    throw new Error(`unknown status "${name ?? ''}". Statuses: ${statusNames(board)}`);
  }
  return option;
};

const requireItem = (board, ref) => {
  if (!ref) throw new Error('which item? Pass its list number or part of its title.');
  const { item, error } = findItem(board.items, ref);
  if (error) throw new Error(error);
  return item;
};

const requireDraft = (item) => {
  if (item.kind !== 'DraftIssue') {
    throw new Error(
      `"${item.title}" is a repo ${item.kind}, not a draft item: edit it with gh issue edit ${item.number}`,
    );
  }
  return item;
};

const readBody = (flags) => {
  if (typeof flags['body-file'] === 'string') return readFileSync(flags['body-file'], 'utf8');
  return typeof flags.body === 'string' ? flags.body : undefined;
};

const commands = {
  statuses: ({ gh, config, out }) => {
    const board = loadBoard(gh, config);
    out(
      board.options,
      board.options.map((option) => `${option.name}: ${option.description}`).join('\n'),
    );
  },

  list: ({ gh, config, flags, out }) => {
    const board = loadBoard(gh, config);
    const wanted =
      typeof flags.status === 'string' ? requireStatus(board, flags.status).name : undefined;
    const rows = board.items
      .map((item, index) => ({ ...item, position: index + 1 }))
      .filter((row) => !wanted || row.status === wanted);
    out(
      rows,
      rows.length === 0
        ? `no items${wanted ? ` in ${wanted}` : ''} (${board.url})`
        : rows
            .map(
              (row) =>
                `${String(row.position).padStart(2)}  ${row.status.padEnd(12)} ${row.title}${row.kind === 'DraftIssue' ? '' : ` (#${row.number})`}`,
            )
            .join('\n'),
    );
  },

  show: ({ gh, config, positional, out }) => {
    const item = requireItem(loadBoard(gh, config), positional[0]);
    out(
      item,
      `# ${item.title}\nStatus: ${item.status}${item.url ? `\n${item.url}` : ''}\n\n${item.body}`,
    );
  },

  add: ({ gh, config, positional, flags, out }) => {
    const title = positional[0];
    if (!title) throw new Error('add needs a title: add "<idea>"');
    const board = loadBoard(gh, config);
    const first = board.options[0];
    const created = addDraft(gh, board.id, title, readBody(flags) ?? '');
    setStatus(gh, board, created.id, first.id);
    out({ id: created.id, status: first.name, title }, `added "${title}" as ${first.name}`);
  },

  move: ({ gh, config, positional, flags, out, today }) => {
    const board = loadBoard(gh, config);
    const item = requireItem(board, positional[0]);
    const status = requireStatus(board, positional[1]);
    const needs = moveRequirements(status.name, flags, today, config.stages);
    if (needs.error) throw new Error(needs.error);
    if (needs.edits.length > 0) {
      setDraftBody(gh, requireDraft(item).contentId, applyEdits(item.body, needs.edits));
    }
    setStatus(gh, board, item.id, status.id);
    out(
      { id: item.id, from: item.status, to: status.name, title: item.title },
      `moved "${item.title}": ${item.status} -> ${status.name}`,
    );
  },

  body: ({ gh, config, positional, flags, out }) => {
    const item = requireDraft(requireItem(loadBoard(gh, config), positional[0]));
    const body = readBody(flags);
    if (body === undefined) throw new Error('body needs --body-file <path> or --body "<text>"');
    setDraftBody(gh, item.contentId, body);
    out({ id: item.id, title: item.title }, `updated "${item.title}"`);
  },
};

// ---------- init ----------

const init = ({ gh, cwd, flags, log }) => {
  const repo = currentRepo(gh);
  const [repoOwner] = repo.nameWithOwner.split('/');
  const existing = readIfExists(path.join(cwd, CONFIG_PATH));
  const previous = existing ? parseConfig(existing).config : undefined;
  const owner = typeof flags.owner === 'string' ? flags.owner : (previous?.owner ?? repoOwner);
  const wantedNumber = flags.project ? Number(flags.project) : previous?.project;
  const title =
    typeof flags.title === 'string' ? flags.title : `${repo.nameWithOwner.split('/')[1]} planning`;

  const number = wantedNumber ?? createProject(gh, owner, title);
  log(wantedNumber ? `using project ${number} of ${owner}` : `created project ${number} "${title}" for ${owner}`);

  const project = fetchProject(gh, owner, number);
  if (!project.field?.options) throw new Error('the project has no single-select "Status" field');
  const stagePlan = planStages(
    project.field.options.map((option) => option.name),
    project.nodes.length,
  );
  if (stagePlan.action === 'stop') throw new Error(stagePlan.reason);
  if (stagePlan.action === 'replace') replaceStages(gh, project.field.id, DEFAULT_STAGES);
  log(
    stagePlan.action === 'keep'
      ? 'stages already set'
      : `stages set: ${DEFAULT_STAGES.map((stage) => stage.name).join(', ')}`,
  );

  const branch = repo.defaultBranchRef?.name ?? 'main';
  const docUrl = `${repo.url}/blob/${branch}/docs/planning-board.md`;
  describeProject(
    gh,
    project.id,
    `Product ideas and decisions for ${repo.nameWithOwner}. Not the issue tracker.`,
    `Planning board: product ideas move ${DEFAULT_STAGES.map((stage) => stage.name).join(' -> ')}. Items are draft items holding the goal, open questions, decisions and spec. Development work lives in repo issues. How to use it: ${docUrl}`,
  );
  try {
    linkRepo(gh, project.id, repo.id);
    log(`linked to ${repo.nameWithOwner}`);
  } catch (error) {
    log(`could not link the project to the repo: ${error.message.split('\n')[0]}`);
  }

  const values = { PROJECT_URL: project.url, CLI };
  const template = (name) => fillTemplate(readFileSync(path.join(templatesDir, name), 'utf8'), values);
  const desired = {
    [CONFIG_PATH]: `${JSON.stringify({ owner, project: number }, null, 2)}\n`,
    [path.join('.claude', 'skills', 'planning-board', 'SKILL.md')]: template('SKILL.md'),
    [path.join('docs', 'planning-board.md')]: template('planning-board.md'),
  };
  const agents = readIfExists(path.join(cwd, 'AGENTS.md'));
  const files = {
    ...desired,
    ...(agents === undefined ? {} : { 'AGENTS.md': addAgentsPointer(agents, CLI) }),
  };
  const current = Object.fromEntries(
    Object.keys(files).map((file) => [file, readIfExists(path.join(cwd, file))]),
  );
  // AGENTS.md is always safe to rewrite: the pointer is only ever appended.
  const plan = planFiles(files, current, flags.force === true).map((step) =>
    step.path === 'AGENTS.md' && step.action === 'skip'
      ? { ...step, action: 'write', content: files['AGENTS.md'] }
      : step,
  );
  plan.forEach((step) => {
    if (step.action === 'write') {
      mkdirSync(path.dirname(path.join(cwd, step.path)), { recursive: true });
      writeFileSync(path.join(cwd, step.path), step.content);
    }
    log(
      `${step.action === 'write' ? 'wrote' : step.action === 'same' ? 'unchanged' : 'SKIPPED'} ${step.path}${step.reason ? ` (${step.reason})` : ''}`,
    );
  });

  log(`\nboard: ${project.url}`);
  log('one manual step: in the project, New view -> Board (GitHub has no API for views).');
  log(`try it: ${CLI} list`);
};

const USAGE = `usage: ${CLI} <command>
  init [--project <number>] [--owner <login>] [--title <title>] [--force]
                                     set up the board and the repo files
  list [--status <status>]           items, in stage order
  show <item>                        title, status, body
  add "<title>" [--body-file <path>] log an idea in the first stage
  body <item> --body-file <path>     replace an item's body
  move <item> <status>               Decided needs --maintainer-said "<words>"
                                     In progress needs --issue <n>[,<n>]
  statuses                           stage names and meanings
<item> is the number from list, or a unique part of the title. Add --json for JSON.
The board is read from .github/board.json: { "owner": "<login>", "project": <number> }`;

export const runBoard = (argv, { gh = createGh(), cwd = process.cwd() } = {}) => {
  const [name, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const out = (value, text) => console.log(flags.json ? JSON.stringify(value, null, 2) : text);
  try {
    if (name === 'init') {
      init({ gh, cwd, flags, log: (line) => console.log(line) });
      return 0;
    }
    if (!commands[name]) {
      console.log(USAGE);
      return name && name !== 'help' ? 1 : 0;
    }
    commands[name]({
      gh,
      config: loadConfig(cwd),
      positional,
      flags,
      out,
      today: new Date().toISOString().slice(0, 10),
    });
    return 0;
  } catch (error) {
    console.error(`✗ ${error.message}`);
    return 1;
  }
};
