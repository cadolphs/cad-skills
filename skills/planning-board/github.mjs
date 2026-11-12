// The only file that talks to GitHub. Everything goes through `gh`.
import { spawnSync } from 'node:child_process';

const SCOPE_HINT =
  'the gh token cannot reach the board (it needs the "project" scope: gh auth refresh -s project). Put the notes in the PR or issue instead.';

export const createGh = (run = spawnSync) => {
  const graphql = (query, variables = {}) => {
    const result = run('gh', ['api', 'graphql', '--input', '-'], {
      encoding: 'utf8',
      input: JSON.stringify({ query, variables }),
    });
    if (result.error) throw new Error(`cannot run gh: ${result.error.message}`);
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    if (result.status !== 0) {
      throw new Error(
        /scope|not accessible|Could not resolve to a ProjectV2/i.test(detail)
          ? `${SCOPE_HINT}\n${detail}`
          : detail,
      );
    }
    return JSON.parse(result.stdout).data;
  };

  const text = (args) => {
    const result = run('gh', args, { encoding: 'utf8' });
    if (result.error) throw new Error(`cannot run gh: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${result.stderr}`.trim());
    return result.stdout.trim();
  };

  return { graphql, text };
};

const ITEMS = `items(first: 100, after: $cursor) {
  pageInfo { hasNextPage endCursor }
  nodes {
    id
    fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { __typename
      ... on DraftIssue { id title body }
      ... on Issue { number title url body }
      ... on PullRequest { number title url body }
    }
  }
}`;

const PROJECT_QUERY = `query($owner: String!, $number: Int!, $cursor: String) {
  repositoryOwner(login: $owner) {
    id
    ... on ProjectV2Owner { projectV2(number: $number) {
      id url title
      field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name description } } }
      ${ITEMS}
    } }
  }
}`;

// Reads the project with every item, following pages.
export const fetchProject = (gh, owner, number) => {
  const page = (cursor, nodes) => {
    const data = gh.graphql(PROJECT_QUERY, { owner, number, cursor });
    const project = data.repositoryOwner?.projectV2;
    if (!project) {
      throw new Error(`no project ${number} found for ${owner} (or ${SCOPE_HINT})`);
    }
    const all = [...nodes, ...project.items.nodes];
    return project.items.pageInfo.hasNextPage
      ? page(project.items.pageInfo.endCursor, all)
      : { ...project, nodes: all };
  };
  return page(null, []);
};

export const setStatus = (gh, board, itemId, optionId) =>
  gh.graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
    { project: board.id, item: itemId, field: board.fieldId, option: optionId },
  );

export const setDraftBody = (gh, draftId, body) =>
  gh.graphql(
    `mutation($id: ID!, $body: String!) {
      updateProjectV2DraftIssue(input: { draftIssueId: $id, body: $body }) { draftIssue { id } }
    }`,
    { id: draftId, body },
  );

export const addDraft = (gh, projectId, title, body) =>
  gh.graphql(
    `mutation($project: ID!, $title: String!, $body: String!) {
      addProjectV2DraftIssue(input: { projectId: $project, title: $title, body: $body }) { projectItem { id } }
    }`,
    { project: projectId, title, body },
  ).addProjectV2DraftIssue.projectItem;

// ---------- init ----------

export const ownerId = (gh, owner) => {
  const id = gh.graphql(
    `query($owner: String!) { repositoryOwner(login: $owner) { id } }`,
    { owner },
  ).repositoryOwner?.id;
  if (!id) throw new Error(`no GitHub user or organization named ${owner}`);
  return id;
};

export const createProject = (gh, owner, title) =>
  gh.graphql(
    `mutation($owner: ID!, $title: String!) {
      createProjectV2(input: { ownerId: $owner, title: $title }) { projectV2 { number } }
    }`,
    { owner: ownerId(gh, owner), title },
  ).createProjectV2.projectV2.number;

export const replaceStages = (gh, fieldId, stages) =>
  gh.graphql(
    `mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
      updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
    }`,
    { field: fieldId, options: stages },
  );

export const describeProject = (gh, projectId, shortDescription, readme) =>
  gh.graphql(
    `mutation($project: ID!, $short: String!, $readme: String!) {
      updateProjectV2(input: { projectId: $project, shortDescription: $short, readme: $readme }) { projectV2 { id } }
    }`,
    { project: projectId, short: shortDescription, readme },
  );

export const currentRepo = (gh) =>
  JSON.parse(gh.text(['repo', 'view', '--json', 'id,nameWithOwner,url,defaultBranchRef']));

export const linkRepo = (gh, projectId, repositoryId) =>
  gh.graphql(
    `mutation($project: ID!, $repo: ID!) {
      linkProjectV2ToRepository(input: { projectId: $project, repositoryId: $repo }) { repository { id } }
    }`,
    { project: projectId, repo: repositoryId },
  );
