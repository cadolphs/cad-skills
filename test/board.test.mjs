import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STAGES,
  addAgentsPointer,
  addUnderHeading,
  fillTemplate,
  findItem,
  findStatus,
  moveRequirements,
  parseArgs,
  parseConfig,
  planFiles,
  planStages,
  sortByStage,
} from '../skills/planning-board/board.mjs';

test('parseArgs splits positionals, valued flags and boolean flags', () => {
  assert.deepEqual(
    parseArgs(['move', '1', 'Decided', '--maintainer-said', 'go', '--json']),
    {
      positional: ['move', '1', 'Decided'],
      flags: { 'maintainer-said': 'go', json: true },
      skip: false,
    },
  );
});

test('parseConfig accepts owner and project and fills default gate stages', () => {
  assert.deepEqual(parseConfig('{"owner":"me","project":4}').config, {
    owner: 'me',
    project: 4,
    stages: { decided: 'Decided', inProgress: 'In progress' },
  });
});

test('parseConfig lets the repo rename a gate stage', () => {
  const { config } = parseConfig('{"owner":"me","project":4,"stages":{"decided":"Agreed"}}');
  assert.deepEqual(config.stages, { decided: 'Agreed', inProgress: 'In progress' });
});

test('parseConfig rejects bad input with a message naming the file', () => {
  assert.match(parseConfig('{').error, /not valid JSON/);
  assert.match(parseConfig('{"project":4}').error, /"owner"/);
  assert.match(parseConfig('{"owner":"me","project":"4"}').error, /"project"/);
});

test('findStatus ignores case and surrounding space', () => {
  assert.equal(findStatus(DEFAULT_STAGES, ' in PROGRESS ').name, 'In progress');
  assert.equal(findStatus(DEFAULT_STAGES, 'Bogus'), undefined);
});

const items = [
  { id: 'A', title: 'Shared lists' },
  { id: 'B', title: 'Shared recipes' },
  { id: 'C', title: 'Barcode scan' },
];

test('findItem resolves by list number, id, and unique title part', () => {
  assert.equal(findItem(items, '2').item.id, 'B');
  assert.equal(findItem(items, 'C').item.id, 'C');
  assert.equal(findItem(items, 'barcode').item.id, 'C');
});

test('findItem reports no match and ambiguous matches', () => {
  assert.match(findItem(items, 'nope').error, /no item matches/);
  assert.match(findItem(items, 'shared').error, /matches 2 items/);
});

test('addUnderHeading creates the section when it is missing', () => {
  assert.equal(addUnderHeading('## Goal\n\nX\n', 'Issues', '- #1'), '## Goal\n\nX\n\n## Issues\n\n- #1\n');
  assert.equal(addUnderHeading('', 'Issues', '- #1'), '## Issues\n\n- #1\n');
});

test('addUnderHeading appends after the last line of an existing section', () => {
  const body = '## Issues\n\n- #1\n\n## Spec\n\nS\n';
  assert.equal(addUnderHeading(body, 'Issues', '- #2'), '## Issues\n\n- #1\n- #2\n\n## Spec\n\nS\n');
});

test('addUnderHeading fills an empty section and never duplicates a line', () => {
  assert.equal(addUnderHeading('## Issues\n\n## Spec\n', 'Issues', '- #1'), '## Issues\n\n- #1\n\n## Spec\n');
  const body = '## Issues\n\n- #1\n';
  assert.equal(addUnderHeading(body, 'Issues', '- #1'), body);
});

test('a move to Decided needs the maintainer words and records them', () => {
  assert.match(moveRequirements('Decided', {}, '2026-01-01').error, /maintainer/);
  assert.match(moveRequirements('decided', { 'maintainer-said': true }, '2026-01-01').error, /maintainer/);
  assert.deepEqual(moveRequirements('Decided', { 'maintainer-said': 'ship it' }, '2026-01-01').edits, [
    ['Decisions', '- 2026-01-01: moved to Decided. Maintainer: "ship it"'],
  ]);
});

test('a move to In progress needs issue numbers and lists them', () => {
  assert.match(moveRequirements('In progress', {}, 'd').error, /--issue/);
  assert.match(moveRequirements('In progress', { issue: true }, 'd').error, /--issue/);
  assert.match(moveRequirements('In progress', { issue: 'abc' }, 'd').error, /--issue/);
  assert.deepEqual(moveRequirements('in progress', { issue: '23, #7' }, 'd').edits, [
    ['Issues', '- #23'],
    ['Issues', '- #7'],
  ]);
});

test('other moves need nothing, and gate stages follow the config', () => {
  assert.deepEqual(moveRequirements('Exploring', {}, 'd'), { edits: [] });
  const gates = { decided: 'Agreed', inProgress: 'Building' };
  assert.deepEqual(moveRequirements('Decided', {}, 'd', gates), { edits: [] });
  assert.match(moveRequirements('Agreed', {}, 'd', gates).error, /maintainer/);
});

test('sortByStage orders by stage and puts unknown statuses last', () => {
  const sorted = sortByStage(
    [{ status: '(no status)' }, { status: 'Done' }, { status: 'Proposed' }],
    DEFAULT_STAGES,
  );
  assert.deepEqual(sorted.map((item) => item.status), ['Proposed', 'Done', '(no status)']);
});

test('planStages keeps matching stages, replaces on an empty board, stops otherwise', () => {
  const names = DEFAULT_STAGES.map((stage) => stage.name.toUpperCase());
  assert.equal(planStages(names, 9).action, 'keep');
  assert.equal(planStages(['Todo', 'In Progress', 'Done'], 0).action, 'replace');
  const stopped = planStages(['Todo', 'In Progress', 'Done'], 3);
  assert.equal(stopped.action, 'stop');
  assert.match(stopped.reason, /3 item/);
});

test('planFiles writes new files, leaves equal ones, skips changed ones unless forced', () => {
  const desired = { a: '1', b: '2', c: '3' };
  const existing = { a: undefined, b: '2', c: 'mine' };
  assert.deepEqual(planFiles(desired, existing).map((step) => step.action), ['write', 'same', 'skip']);
  assert.deepEqual(planFiles(desired, existing, true).map((step) => step.action), ['write', 'same', 'write']);
});

test('addAgentsPointer appends once', () => {
  const once = addAgentsPointer('# Agents\n', 'cli');
  assert.match(once, /^# Agents\n\n- Product ideas/);
  assert.equal(addAgentsPointer(once, 'cli'), once);
});

test('fillTemplate replaces every occurrence', () => {
  assert.equal(fillTemplate('{{A}} {{B}} {{A}}', { A: 'x', B: 'y' }), 'x y x');
});
