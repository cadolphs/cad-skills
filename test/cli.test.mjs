import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runBoard } from '../skills/planning-board/cli.mjs';
import { fetchProject } from '../skills/planning-board/github.mjs';

const OPTIONS = ['Proposed', 'Exploring', 'Decided', 'In progress', 'Done'].map((name) => ({
  id: `opt-${name}`,
  name,
  description: '',
}));

const draft = (id, title, status, body = '') => ({
  id,
  fieldValueByName: { name: status },
  content: { __typename: 'DraftIssue', id: `DI_${id}`, title, body },
});

// A fake gh: serves one project and records every mutation.
const fakeGh = (nodes, pageSize = 100) => {
  const calls = [];
  const graphql = (query, variables) => {
    if (query.includes('repositoryOwner') && query.includes('projectV2(')) {
      const start = variables.cursor ? Number(variables.cursor) : 0;
      const end = start + pageSize;
      return {
        repositoryOwner: {
          id: 'OWNER',
          projectV2: {
            id: 'PROJECT',
            url: 'https://example.test/p/1',
            field: { id: 'FIELD', options: OPTIONS },
            items: {
              pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) },
              nodes: nodes.slice(start, end),
            },
          },
        },
      };
    }
    calls.push({ query, variables });
    return { addProjectV2DraftIssue: { projectItem: { id: 'NEW' } } };
  };
  return { gh: { graphql, text: () => '' }, calls };
};

const repoWithConfig = (config = { owner: 'me', project: 1 }) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cad-skills-'));
  mkdirSync(path.join(cwd, '.github'));
  writeFileSync(path.join(cwd, '.github', 'board.json'), JSON.stringify(config));
  return cwd;
};

const quiet = (fn) => {
  const { log, error } = console;
  const lines = [];
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    return { code: fn(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
};

test('fetchProject follows pages until every item is read', () => {
  const nodes = Array.from({ length: 5 }, (_, index) => draft(`I${index}`, `Idea ${index}`, 'Proposed'));
  const { gh } = fakeGh(nodes, 2);
  assert.equal(fetchProject(gh, 'me', 1).nodes.length, 5);
});

test('a command without .github/board.json says how to create it', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cad-skills-'));
  const { code, lines } = quiet(() => runBoard(['list'], { gh: fakeGh([]).gh, cwd }));
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /board init/);
});

test('list prints items in stage order with their numbers', () => {
  const { gh } = fakeGh([draft('A', 'Later', 'Done'), draft('B', 'Sooner', 'Proposed')]);
  const { code, lines } = quiet(() => runBoard(['list'], { gh, cwd: repoWithConfig() }));
  assert.equal(code, 0);
  assert.match(lines[0], /^ 1 {2}Proposed +Sooner\n 2 {2}Done +Later$/);
});

test('move to Decided is refused without the maintainer words and changes nothing', () => {
  const { gh, calls } = fakeGh([draft('A', 'Idea', 'Exploring')]);
  const { code } = quiet(() => runBoard(['move', '1', 'decided'], { gh, cwd: repoWithConfig() }));
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('move to Decided records the words in the body, then sets the status', () => {
  const { gh, calls } = fakeGh([draft('A', 'Idea', 'Exploring', '## Goal\n\nG\n')]);
  const { code } = quiet(() =>
    runBoard(['move', 'idea', 'decided', '--maintainer-said', 'yes'], { gh, cwd: repoWithConfig() }),
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].variables.body, /## Decisions\n\n- \d{4}-\d\d-\d\d: moved to Decided\. Maintainer: "yes"/);
  assert.equal(calls[0].variables.id, 'DI_A');
  assert.deepEqual(calls[1].variables, { project: 'PROJECT', item: 'A', field: 'FIELD', option: 'opt-Decided' });
});

test('add creates a draft in the first stage', () => {
  const { gh, calls } = fakeGh([]);
  const { code } = quiet(() => runBoard(['add', 'New idea', '--body', 'B'], { gh, cwd: repoWithConfig() }));
  assert.equal(code, 0);
  assert.deepEqual(calls[0].variables, { project: 'PROJECT', title: 'New idea', body: 'B' });
  assert.equal(calls[1].variables.option, 'opt-Proposed');
});

test('renamed gate stages from the config are enforced', () => {
  const cwd = repoWithConfig({ owner: 'me', project: 1, stages: { decided: 'Exploring' } });
  const { gh, calls } = fakeGh([draft('A', 'Idea', 'Proposed')]);
  const { code } = quiet(() => runBoard(['move', '1', 'Exploring'], { gh, cwd }));
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
});

test('templates carry no unfilled placeholders other than the two init fills', () => {
  const dir = path.join(import.meta.dirname, '..', 'skills', 'planning-board', 'templates');
  const text = readFileSync(path.join(dir, 'SKILL.md'), 'utf8') + readFileSync(path.join(dir, 'planning-board.md'), 'utf8');
  const placeholders = [...new Set(text.match(/\{\{[A-Z_]+\}\}/g))].sort();
  assert.deepEqual(placeholders, ['{{CLI}}', '{{PROJECT_URL}}']);
});
