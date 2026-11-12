// Pure logic for the planning board: no I/O in this file.

export const DEFAULT_STAGES = [
  { name: 'Proposed', color: 'GRAY', description: 'Idea logged. Open questions not yet worked on.' },
  { name: 'Exploring', color: 'BLUE', description: 'Open questions are being discussed and researched. Notes go in the item body.' },
  { name: 'Decided', color: 'GREEN', description: 'All open questions answered. Spec in the body. Ready to break into issues.' },
  { name: 'In progress', color: 'YELLOW', description: 'Development issues exist and are being built.' },
  { name: 'Done', color: 'PURPLE', description: 'Shipped, or dropped with the reason recorded.' },
];

const DEFAULT_GATES = { decided: 'Decided', inProgress: 'In progress' };

export const parseArgs = (argv) =>
  argv.reduce(
    (acc, token, index, all) => {
      if (acc.skip) return { ...acc, skip: false };
      if (!token.startsWith('--')) {
        return { ...acc, positional: [...acc.positional, token] };
      }
      const next = all[index + 1];
      const isValue = next !== undefined && !next.startsWith('--');
      return {
        ...acc,
        flags: { ...acc.flags, [token.slice(2)]: isValue ? next : true },
        skip: isValue,
      };
    },
    { positional: [], flags: {}, skip: false },
  );

export const same = (a, b) =>
  String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// .github/board.json: { "owner": "...", "project": 4, "stages": { "decided": "...", "inProgress": "..." } }
export const parseConfig = (text) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `.github/board.json is not valid JSON: ${error.message}` };
  }
  if (typeof raw?.owner !== 'string' || !raw.owner) {
    return { error: '.github/board.json needs "owner" (a GitHub login)' };
  }
  if (!Number.isInteger(raw.project) || raw.project < 1) {
    return { error: '.github/board.json needs "project" (the project number)' };
  }
  return {
    config: {
      owner: raw.owner,
      project: raw.project,
      stages: { ...DEFAULT_GATES, ...(raw.stages ?? {}) },
    },
  };
};

export const findStatus = (options, name) =>
  options.find((option) => same(option.name, name));

// An item is addressed by its list number, its id, or a unique part of its title.
export const findItem = (items, ref) => {
  const byNumber = /^\d+$/.test(ref) ? items[Number(ref) - 1] : undefined;
  if (byNumber) return { item: byNumber };
  const byId = items.find((item) => item.id === ref);
  if (byId) return { item: byId };
  const matches = items.filter((item) =>
    item.title.toLowerCase().includes(ref.toLowerCase()),
  );
  if (matches.length === 1) return { item: matches[0] };
  return {
    error:
      matches.length === 0
        ? `no item matches "${ref}"`
        : `"${ref}" matches ${matches.length} items: ${matches.map((item) => item.title).join(' | ')}`,
  };
};

// Add a line under a `## Heading`, creating the section at the end if missing.
export const addUnderHeading = (body, heading, line) => {
  const lines = (body ?? '').split('\n');
  if (lines.some((existing) => existing.trim() === line.trim())) {
    return lines.join('\n');
  }
  const start = lines.findIndex((existing) => same(existing, `## ${heading}`));
  if (start === -1) {
    const base = (body ?? '').trimEnd();
    return `${base}${base ? '\n\n' : ''}## ${heading}\n\n${line}\n`;
  }
  const nextHeading = lines.findIndex(
    (existing, index) => index > start && existing.startsWith('## '),
  );
  const end = nextHeading === -1 ? lines.length : nextHeading;
  const lastContent = lines
    .slice(start + 1, end)
    .reduce(
      (last, existing, offset) => (existing.trim() ? start + 1 + offset : last),
      start,
    );
  const insert = lastContent === start ? ['', line] : [line];
  return [
    ...lines.slice(0, lastContent + 1),
    ...insert,
    ...lines.slice(lastContent + 1),
  ].join('\n');
};

// What a move needs beyond the target status: an error, or edits to the body.
export const moveRequirements = (status, flags, today, gates = DEFAULT_GATES) => {
  if (same(status, gates.decided)) {
    return typeof flags['maintainer-said'] === 'string'
      ? {
          edits: [
            ['Decisions', `- ${today}: moved to ${status}. Maintainer: "${flags['maintainer-said']}"`],
          ],
        }
      : { error: `only the maintainer moves an item to ${status}: pass --maintainer-said "<their words>"` };
  }
  if (same(status, gates.inProgress)) {
    const issues = String(flags.issue === true ? '' : (flags.issue ?? ''))
      .split(',')
      .map((issue) => issue.trim().replace(/^#/, ''))
      .filter(Boolean);
    return issues.length > 0 && issues.every((issue) => /^\d+$/.test(issue))
      ? { edits: issues.map((issue) => ['Issues', `- #${issue}`]) }
      : { error: `${status} needs the development issue(s): pass --issue <number>[,<number>]` };
  }
  return { edits: [] };
};

export const applyEdits = (body, edits) =>
  edits.reduce((text, [heading, line]) => addUnderHeading(text, heading, line), body);

export const toItem = (node) => ({
  id: node.id,
  status: node.fieldValueByName?.name ?? '(no status)',
  kind: node.content?.__typename ?? 'Unknown',
  contentId: node.content?.id,
  number: node.content?.number,
  url: node.content?.url,
  title: node.content?.title ?? '(untitled)',
  body: node.content?.body ?? '',
});

export const sortByStage = (items, options) => {
  const order = (item) => {
    const index = options.findIndex((option) => option.name === item.status);
    return index === -1 ? options.length : index;
  };
  return [...items].sort((a, b) => order(a) - order(b));
};

// ---------- init planning ----------

// What to do with the Status options of an existing project.
export const planStages = (currentNames, itemCount, wanted = DEFAULT_STAGES) => {
  const matches =
    currentNames.length === wanted.length &&
    wanted.every((stage, index) => same(stage.name, currentNames[index]));
  if (matches) return { action: 'keep' };
  if (itemCount > 0) {
    return {
      action: 'stop',
      reason: `the board has ${itemCount} item(s) and its stages are ${currentNames.join(', ')}. Replacing stages clears every item's status: rename them in the project settings instead.`,
    };
  }
  return { action: 'replace' };
};

// Decide per file: write it, leave it (same content), or skip it (differs, no --force).
export const planFiles = (desired, existing, force = false) =>
  Object.entries(desired).map(([path, content]) => {
    const current = existing[path];
    if (current === undefined) return { path, action: 'write', content };
    if (current === content) return { path, action: 'same' };
    return force
      ? { path, action: 'write', content }
      : { path, action: 'skip', reason: 'exists with different content (use --force)' };
  });

export const AGENTS_LINE = (cli) =>
  `- Product ideas, open questions, decisions, and specs live as draft items on the planning board, not in issues: [docs/planning-board.md](docs/planning-board.md), [planning-board skill](.claude/skills/planning-board/SKILL.md) (\`${cli} list\`)`;

export const addAgentsPointer = (agentsText, cli) =>
  agentsText.includes('planning-board')
    ? agentsText
    : `${agentsText.trimEnd()}\n\n${AGENTS_LINE(cli)}\n`;

export const fillTemplate = (template, values) =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );
