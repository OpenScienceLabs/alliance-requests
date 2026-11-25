'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MARKER, collectEvidence, renderReport, repositorySlug, run, sections,
  shouldReview, synthesize, validateSynthesis,
} = require('./review-affiliation.cjs');

const SHA = 'a'.repeat(40);
const issue = {
  number: 7, state: 'open', title: 'Affiliation request: Example', labels: [],
  body: '### Repository URL\n\nhttps://github.com/example/tool\n\n### Maintainers\n\nPerson <person@example.org>',
};
const context = {
  repo: { owner: 'OpenScienceLabs', repo: 'alliance-requests' }, sha: 'b'.repeat(40),
  payload: { action: 'opened', issue },
};

function fixture() {
  const calls = [];
  const comments = [{ id: 1, user: { login: 'applicant' }, body: MARKER }];
  const wrap = (name, fn) => async args => { calls.push({ name, args }); return { data: await fn(args) }; };
  const github = { rest: {
    repos: {
      get: wrap('repo', () => ({ private: false, full_name: 'example/tool', default_branch: 'main', has_issues: true })),
      getCommit: wrap('commit', () => ({ sha: SHA })),
      getContent: wrap('file', () => ({ type: 'file', encoding: 'base64', size: 12, content: Buffer.from('Example source').toString('base64') })),
      listCommits: wrap('commits', () => [{ sha: SHA, commit: { message: 'Fix behavior', committer: { date: '2026-11-01' } } }]),
      listReleases: wrap('releases', () => []),
    },
    git: {
      getTree: wrap('tree', () => ({ tree: ['README.md', 'LICENSE', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', '.github/workflows/test.yml', 'tests/test.py', 'src/core.py'].map(path => ({ path, type: 'blob' })) })),
    },
    issues: {
      get: wrap('issue', () => structuredClone(issue)),
      listForRepo: wrap('issues', () => [{ number: 3, title: 'A PR', pull_request: {} }, { number: 2, title: 'A bug' }]),
      listComments: wrap('comments', () => comments),
      createComment: wrap('create', args => {
        comments.push({ id: 2, user: { login: 'github-actions[bot]' }, body: args.body });
      }),
      updateComment: wrap('update', args => { comments.find(item => item.id === args.comment_id).body = args.body; }),
    },
    actions: { listWorkflowRunsForRepo: wrap('runs', () => ({ workflow_runs: [] })) },
  } };
  github.paginate = async (method, args) => (await method(args)).data;
  return { github, calls, comments, core: { info() {}, warning() {} } };
}

const collect = github => collectEvidence({ github, issue, repository: 'OpenScienceLabs/alliance-requests', now: new Date('2026-11-25T00:00:00Z') });
const validResult = bundle => ({
  summary: 'Preliminary evidence is available; human verification remains necessary.',
  readiness: 'human_judgment_required',
  criteria: Array.from({ length: 12 }, (_, index) => ({
    criterion: `R${index + 1}`, assessment: 'human_review', rationale: 'Requires human verification.', evidence_ids: [bundle.evidence[0].id],
  })),
  strengths: [], risks: ['Limited source sample.'], questions: [], human_review_focus: ['Verify the development lifecycle.'],
});

test('creation and the exact triage label trigger affiliation reviews, including legacy title detection', () => {
  assert.equal(shouldReview({ action: 'opened', issue }), true);
  const labeled = { ...issue, title: 'Legacy application', labels: [{ name: 'type: affiliation-request' }] };
  assert.equal(shouldReview({ action: 'labeled', label: { name: 'status: needs-triage' }, issue: labeled }), true);
  for (const payload of [
    { action: 'labeled', label: { name: 'check: license' }, issue },
    { action: 'unlabeled', label: { name: 'status: needs-triage' }, issue },
    { action: 'edited', issue },
    { action: 'opened', issue: { ...issue, state: 'closed' } },
    { action: 'opened', issue: { ...issue, title: 'Bug report' } },
    { action: 'opened', issue: { ...issue, pull_request: {} } },
  ]) assert.equal(shouldReview(payload), false);
});

test('form parsing handles CRLF and ignores body links outside the repository field', () => {
  assert.deepEqual(sections('### Project name\r\n\r\nA\r\n\r\n### Notes\r\n\r\nB'), { 'Project name': 'A', Notes: 'B' });
  assert.deepEqual(repositorySlug('https://github.com/org/project.git/'), { owner: 'org', repo: 'project' });
  for (const url of [
    'http://github.com/org/project', 'https://github.com.evil.test/org/project',
    'https://user:password@github.com/org/project', 'https://github.com/org/project/issues',
    'https://127.0.0.1/org/project', 'https://github.com/org/project?token=secret',
    'https://github.com/org/%2e%2e', 'https://gitlab.com/org/project',
  ]) assert.equal(repositorySlug(url), null);
});

test('collection pins file, commit and CI reads and distinguishes claims from observations', async () => {
  const { github, calls } = fixture();
  const bundle = await collect(github);
  assert.equal(bundle.revision, SHA);
  assert.equal(bundle.evidence[0].type, 'reported');
  assert.equal(bundle.evidence[0].detail.includes('person@example.org'), false);
  assert.equal(calls.filter(call => call.name === 'file').length, 9);
  assert.ok(calls.filter(call => call.name === 'file').every(call => call.args.ref === SHA));
  assert.equal(calls.find(call => call.name === 'commits').args.sha, SHA);
  assert.equal(calls.find(call => call.name === 'runs').args.head_sha, SHA);
  assert.equal(bundle.evidence.find(entry => entry.title.startsWith('Recent issues')).detail.includes('A PR'), false);
  assert.equal(new Set(bundle.evidence.map(entry => entry.id)).size, bundle.evidence.length);
});

test('private and inaccessible repositories remain unknown and no contents are fetched', async () => {
  for (const get of [
    async () => ({ data: { private: true } }),
    async () => { throw Object.assign(new Error('private diagnostic'), { status: 403 }); },
  ]) {
    const { github, calls } = fixture();
    github.rest.repos.get = get;
    const bundle = await collect(github);
    assert.equal(bundle.repository, null);
    assert.equal(bundle.revision, null);
    assert.equal(calls.length, 0);
    assert.equal(bundle.evidence.length, 1);
    assert.ok(bundle.limitations.some(item => /visibility|unavailable/.test(item)));
    assert.equal(JSON.stringify(bundle).includes('private diagnostic'), false);
  }
});

test('failed CI reads are unavailable rather than a failing project check', async () => {
  const { github } = fixture();
  github.rest.actions.listWorkflowRunsForRepo = async () => { throw Object.assign(new Error('sensitive'), { status: 403 }); };
  const bundle = await collect(github);
  const ci = bundle.evidence.find(entry => entry.title.startsWith('Latest CI'));
  assert.equal(ci.type, 'unavailable');
  assert.match(ci.detail, /403/);
  assert.equal(ci.detail.includes('sensitive'), false);
});

test('file selection searches beyond the first displayed inventory page and encodes unsafe link characters', async () => {
  const { github, calls } = fixture();
  const paths = [...Array.from({ length: 110 }, (_, i) => `assets/${i}.txt`), 'README.md', 'tests/test_(example).py'];
  github.rest.git.getTree = async () => ({ data: { truncated: true, tree: paths.map(path => ({ path, type: 'blob' })) } });
  const bundle = await collect(github);
  assert.ok(calls.some(call => call.name === 'file' && call.args.path === 'README.md'));
  assert.ok(bundle.limitations.some(item => item.includes('truncated the source tree')));
  assert.match(bundle.evidence.find(entry => entry.title.includes('test_(example)')).url, /%28example%29/);
});

test('synthesis receives trusted guidelines separately from evidence and uses strict structured output', async () => {
  const bundle = await collect(fixture().github);
  const result = validResult(bundle);
  const output = await synthesize(bundle, {
    apiKey: 'test-key', model: 'configured-model', skill: 'TRUSTED SKILL', policy: 'ADOPTED POLICY',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.match(body.instructions, /TRUSTED SKILL/);
      assert.match(body.instructions, /ADOPTED POLICY/);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.store, false);
      assert.equal(body.model, 'configured-model');
      assert.deepEqual(JSON.parse(body.input[0].content), bundle);
      assert.equal(body.tools, undefined);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
    },
  });
  assert.deepEqual(output, result);
});

test('invalid, fabricated or decision-bearing AI output is rejected', async () => {
  const bundle = await collect(fixture().github);
  assert.deepEqual(validateSynthesis(validResult(bundle), bundle), validResult(bundle));
  for (const mutate of [
    result => { result.criteria[0].evidence_ids = ['E999']; },
    result => { result.summary = 'This project is approved.'; },
    result => { result.criteria[1].criterion = 'R1'; },
    result => { result.criteria[0].assessment = 'satisfied'; result.criteria[0].evidence_ids = []; },
    result => { result.extra = 'unexpected'; },
    result => { result.criteria = []; },
    result => { result.risks = ['x'.repeat(1601)]; },
  ]) {
    const result = validResult(bundle);
    mutate(result);
    assert.throws(() => validateSynthesis(result, bundle), /advisory review contract/);
  }
  for (const data of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
  ]) await assert.rejects(synthesize(bundle, {
    apiKey: 'test', model: 'test', skill: '', policy: '',
    fetchImpl: async () => ({ ok: true, json: async () => data }),
  }));
});

test('public rendering neutralizes applicant Markdown, mentions, emails and links', async () => {
  const bundle = await collect(fixture().github);
  bundle.evidence[0].detail = '[click](https://evil.test) <img src=x> @everyone person@example.org | next row';
  const report = renderReport(bundle, null, { guidelineUrl: 'https://github.com/org/repo/blob/main/skill', synthesisStatus: 'unavailable' });
  assert.equal(report.includes('@everyone'), false);
  assert.equal(report.includes('person@example.org'), false);
  assert.equal(report.includes('[click](https://evil.test)'), false);
  assert.equal(report.includes('<img'), false);
  assert.match(report, /No AI assessment is available/);
});

test('repeated reviews reuse the bot comment and never edit an applicant marker spoof', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  await run({ ...mock, context });
  await run({ ...mock, context: { ...context, payload: { action: 'labeled', issue, label: { name: 'status: needs-triage' } } } });
  assert.equal(mock.calls.filter(call => call.name === 'create').length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'update').length, 1);
  assert.equal(mock.comments[0].body, MARKER);
  assert.match(mock.comments[1].body, /not configured/);
});

test('AI service failure still publishes evidence without leaking the error', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  await run({ ...mock, context, fetchImpl: async () => { throw new Error('unit-test-key private diagnostic'); } });
  assert.match(mock.comments[1].body, /evidence-only fallback/);
  assert.equal(mock.comments[1].body.includes('unit-test-key'), false);
  assert.equal(mock.comments[1].body.includes('private diagnostic'), false);
});

test('a changed application cannot receive a stale report', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  let reads = 0;
  mock.github.rest.issues.get = async () => ({ data: { ...issue, body: ++reads === 1 ? issue.body : 'Updated application' } });
  await run({ ...mock, context });
  assert.equal(mock.comments.length, 1);
});
