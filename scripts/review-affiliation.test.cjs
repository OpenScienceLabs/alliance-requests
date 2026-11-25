'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACK_MARKER, MARKER, applyIntakeLabels, collectEvidence, renderReport, repositorySlug, reviewSchema, run, sections,
  shouldReview, synthesize, validateSynthesis,
} = require('./review-affiliation.cjs');

const originalKey = process.env.OPENAI_API_KEY;
test.before(() => { process.env.OPENAI_API_KEY = 'unit-test-key'; });
test.after(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; });

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
  const currentIssue = structuredClone(issue);
  const comments = [{ id: 1, user: { login: 'applicant' }, body: MARKER }];
  const summaries = [];
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
      get: wrap('issue', args => structuredClone({ ...currentIssue, number: args.issue_number })),
      addLabels: wrap('labels', args => {
        const existing = new Set(currentIssue.labels.map(label => label.name));
        currentIssue.labels.push(...args.labels.filter(name => !existing.has(name)).map(name => ({ name })));
      }),
      listForRepo: wrap('issues', () => [{ number: 3, title: 'A PR', pull_request: {} }, { number: 2, title: 'A bug' }]),
      listComments: wrap('comments', () => comments),
      getComment: wrap('readback', args => structuredClone(comments.find(item => item.id === args.comment_id))),
      createComment: wrap('create', args => {
        const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body: args.body };
        comments.push(comment);
        return structuredClone(comment);
      }),
      updateComment: wrap('update', args => { comments.find(item => item.id === args.comment_id).body = args.body; }),
    },
    actions: { listWorkflowRunsForRepo: wrap('runs', () => ({ workflow_runs: [] })) },
  } };
  github.paginate = async (method, args) => (await method(args)).data;
  return {
    github, calls, comments, currentIssue, summaries, wait: async () => {},
    core: { info() {}, warning() {}, summary: { addRaw(text) { summaries.push(text); return this; }, async write() {} } },
    fetchImpl: async (url, options) => modelResponse(validResult(JSON.parse(JSON.parse(options.body).input[0].content))),
  };
}

function modelResponse(result) {
  return { ok: true, status: 200, headers: new Headers({ 'x-request-id': 'req-unit-test' }), json: async () => ({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  }) };
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

test('transferred incubation applications can be reviewed without a type label', () => {
  const legacy = { ...issue, title: 'Incubation application: Formulon Physics', labels: [{ name: 'status: in-review' }] };
  for (const action of ['opened', 'reopened', 'transferred', 'labeled']) {
    assert.equal(shouldReview({ action, label: { name: 'status: needs-triage' }, issue: legacy }), true);
  }
  assert.equal(shouldReview({ action: 'edited', issue: legacy }), false);
});

test('legacy form headings satisfy the corresponding intake fields without replacing current answers', async () => {
  const body = [
    '### Project name\nExample', '### Repository URL\nhttps://gitlab.com/example/tool',
    '### Short description\nTool', '### Alignment with OSL\nScience',
    '### License link\nPublic policy', '### Code of Conduct link\nPublic policy',
    '### Maintainers\nSomeone', '### Public communication channel or contact path\nIssues',
    '### Current maintenance status\nStable', '### Maintenance context\nMaintained',
    '### Expected OSL support\nCommunity', '### Confirmations\n- [x] Understood',
  ].join('\n\n');
  const bundle = await collectEvidence({ github: {}, issue: { ...issue, body }, repository: 'org/repo' });
  assert.deepEqual(bundle.missing_fields, []);
  const fields = sections(`${body}\n\n### Maintenance status\nActive`);
  assert.equal(fields['Maintenance status'], 'Active');
  assert.equal(fields['Required checks'], '- [x] Understood');
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
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  await run({ ...mock, context });
  await run({ ...mock, context: { ...context, payload: { action: 'labeled', issue, label: { name: 'status: needs-triage' } } } });
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(MARKER)).length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(ACK_MARKER)).length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'update').length, 1);
  assert.equal(mock.comments[0].body, MARKER);
  assert.match(mock.comments.find(comment => comment.body.startsWith(MARKER) && comment.user.login === 'github-actions[bot]').body, /AI synthesis: completed/);
});

test('AI service failure fails the run and preserves the previous public evaluation', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  const previous = { id: 2, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nPrevious evaluation` };
  mock.comments.push(previous);
  await assert.rejects(run({ ...mock, context, fetchImpl: async () => { throw new Error('unit-test-key private diagnostic'); } }), error => error.code === 'OPENAI_NETWORK_ERROR');
  assert.equal(previous.body, `${MARKER}\nPrevious evaluation`);
  assert.equal(mock.calls.some(call => ['create', 'update', 'labels'].includes(call.name)), false);
  assert.match(mock.summaries[0], /Review outcome: failed/);
  assert.equal(mock.summaries[0].includes('private diagnostic'), false);
  assert.equal(mock.summaries[0].includes('unit-test-key'), false);
});

test('a changed application cannot receive a stale report', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  let reads = 0;
  mock.github.rest.issues.get = async () => ({ data: { ...issue, body: ++reads === 1 ? issue.body : 'Updated application' } });
  await assert.rejects(run({ ...mock, context }), error => error.code === 'APPLICATION_CHANGED');
  assert.equal(mock.comments.filter(comment => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(MARKER)).length, 0);
});

test('manual dispatch reviews the selected issue without requiring a new label event', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  mock.currentIssue.title = 'Incubation application: Formulon Physics';
  mock.currentIssue.labels = [{ name: 'status: in-review' }];
  await run({ ...mock, context: { ...context, eventName: 'workflow_dispatch', payload: { inputs: { issue_number: '7' } } } });
  assert.ok(mock.calls.filter(call => call.name === 'issue').every(call => call.args.issue_number === 7));
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(MARKER)).length, 1);
  assert.deepEqual(mock.calls.find(call => call.name === 'labels').args.labels, ['type: affiliation-request']);
  assert.equal(mock.currentIssue.labels.filter(label => label.name.startsWith('status: ')).length, 1);
});

test('edited applications receive routine intake labels without starting AI review', async () => {
  const mock = fixture();
  await run({ ...mock, context: { ...context, payload: { action: 'edited', issue } } });
  assert.deepEqual(mock.calls.find(call => call.name === 'labels').args.labels, ['type: affiliation-request', 'status: needs-triage']);
  assert.equal(mock.calls.some(call => call.name === 'repo' || call.name === 'create'), false);
});

test('manual dispatch rejects invalid issue numbers and skips unrelated or closed issues', async () => {
  for (const number of ['', '0', '-1', '1.5', '1; echo secret', '9007199254740992']) {
    const mock = fixture();
    await assert.rejects(run({ ...mock, context: { ...context, eventName: 'workflow_dispatch', payload: { inputs: { issue_number: number } } } }), /positive integer/);
    assert.equal(mock.calls.length, 0);
  }
  for (const update of [{ state: 'closed' }, { title: 'Maintenance review: Example', labels: [{ name: 'type: maintenance-review' }] }]) {
    const mock = fixture();
    Object.assign(mock.currentIssue, update);
    await assert.rejects(run({ ...mock, context: { ...context, eventName: 'workflow_dispatch', payload: { inputs: { issue_number: '7' } } } }), error => error.code === 'APPLICATION_NOT_REVIEWABLE');
    assert.equal(mock.calls.some(call => ['create', 'labels', 'repo'].includes(call.name)), false);
  }
});

test('transient label errors retry with bounded backoff and recover without repeating comments', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  const addLabels = mock.github.rest.issues.addLabels;
  const waits = [];
  let attempts = 0;
  mock.github.rest.issues.addLabels = async args => {
    // The server can apply labels and then lose its response. A retry must still
    // produce just one label set, acknowledgement, and report.
    const result = await addLabels(args);
    if (++attempts < 3) throw Object.assign(new Error('GitHub server error'), { status: 500 });
    return result;
  };
  await run({ ...mock, context, wait: async milliseconds => { waits.push(milliseconds); } });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(mock.currentIssue.labels.length, 2);
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(ACK_MARKER)).length, 1);
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(MARKER)).length, 1);
});

test('persistent label server errors warn and still publish a review for the legacy application', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'unit-test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  mock.currentIssue.title = 'Incubation application: Formulon Physics';
  mock.currentIssue.labels = [{ name: 'status: in-review' }];
  let attempts = 0;
  const warnings = [];
  mock.core.warning = message => { warnings.push(message); };
  mock.github.rest.issues.addLabels = async () => {
    attempts++;
    throw Object.assign(new Error('private request headers and credential'), { status: 500 });
  };
  await run({ ...mock, wait: async () => {}, context: {
    ...context, eventName: 'workflow_dispatch', payload: { inputs: { issue_number: '1' } },
  } });
  assert.equal(attempts, 3);
  assert.equal(warnings.length, 1);
  const report = mock.comments.find(comment => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(MARKER));
  assert.ok(report);
  assert.match(report.body, /intake label updates after 3 attempts/);
  assert.equal(report.body.includes('private request'), false);
  assert.equal(warnings[0].includes('credential'), false);
});

test('permission and validation failures are surfaced immediately without retries or request dumps', async () => {
  for (const status of [401, 403, 404, 422, 429]) {
    const mock = fixture();
    let attempts = 0;
    const waits = [];
    mock.github.rest.issues.addLabels = async () => {
      attempts++;
      throw Object.assign(new Error('private request headers and credential'), { status });
    };
    await assert.rejects(applyIntakeLabels({
      ...mock, issueArgs: { ...context.repo, issue_number: 1 }, labels: ['type: affiliation-request'],
      wait: async milliseconds => { waits.push(milliseconds); },
    }), error => error.message.includes(`HTTP ${status}`) && !error.message.includes('credential'));
    assert.equal(attempts, 1);
    assert.deepEqual(waits, []);
  }
});

test('comment creation errors stay visible and cannot be duplicated by the label retry mechanism', async () => {
  const mock = fixture();
  mock.currentIssue.labels = [{ name: 'type: affiliation-request' }, { name: 'status: in-review' }];
  let attempts = 0;
  mock.github.rest.issues.createComment = async () => {
    attempts++;
    throw Object.assign(new Error('GitHub comment service unavailable'), { status: 500 });
  };
  await assert.rejects(run({ ...mock, context: {
    ...context, eventName: 'workflow_dispatch', payload: { inputs: { issue_number: '1' } },
  } }), error => error.code === 'REVIEW_PUBLICATION_FAILED');
  assert.equal(attempts, 1);
});

test('a complete structured review is rendered, saved, read back, and linked as the successful outcome', async () => {
  const mock = fixture();
  const outcome = await run({ ...mock, context });
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.rubric_areas, 12);
  assert.equal(outcome.revision, SHA);
  assert.equal(outcome.readiness, 'human_judgment_required');
  assert.match(outcome.comment_url, /issues\/7#issuecomment-2$/);
  const report = mock.comments.find(comment => comment.body.startsWith(MARKER) && comment.user.login === 'github-actions[bot]');
  assert.match(report.body, /\| R12 \| human_review \|/);
  assert.equal(mock.calls.find(call => call.name === 'readback').args.comment_id, report.id);
  assert.match(mock.summaries[0], /Review outcome: published/);
  assert.match(mock.summaries[0], /Verified issue comment/);
});

test('read-only preview produces the complete evaluation and artifacts without issue mutations', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(__dirname, '.review-test-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const mock = fixture();
  const outcome = await run({ ...mock, context, publish: false, outputDirectory });
  assert.equal(outcome.status, 'preview');
  assert.equal(outcome.rubric_areas, 12);
  assert.equal(mock.calls.some(call => ['create', 'update', 'labels', 'readback'].includes(call.name)), false);
  const report = fs.readFileSync(path.join(outputDirectory, 'report.md'), 'utf8');
  assert.match(report, /\| R1 \| human_review \|/);
  assert.match(report, /\| R12 \| human_review \|/);
  assert.equal(report.includes('unit-test-key'), false);
  const saved = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'result.json')));
  assert.equal(saved.status, 'preview');
  assert.equal(saved.revision, SHA);
  assert.equal(saved.rubric_areas, 12);
});

test('the provider schema enforces rubric IDs, item counts, and real evidence references', async () => {
  const bundle = await collect(fixture().github);
  const schema = reviewSchema(bundle);
  assert.equal(schema.properties.criteria.minItems, 12);
  assert.equal(schema.properties.criteria.maxItems, 12);
  assert.equal(schema.properties.risks.maxItems, 8);
  assert.deepEqual(schema.properties.criteria.items.properties.criterion.enum, Array.from({ length: 12 }, (_, i) => `R${i + 1}`));
  assert.deepEqual(schema.properties.criteria.items.properties.evidence_ids.items.enum, bundle.evidence.map(entry => entry.id));
});

test('invalid decision vocabulary gets one corrective model request before publication', async () => {
  const mock = fixture();
  const retryWarnings = [];
  const requests = [];
  mock.core.warning = warning => { retryWarnings.push(warning); };
  const outcome = await run({ ...mock, context, fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const bundle = JSON.parse(request.input[0].content);
    const result = validResult(bundle);
    if (requests.length === 1) result.criteria[11].rationale = 'The project uses an OSI-approved license.';
    else assert.equal(mock.calls.some(call => ['create', 'update'].includes(call.name)), false);
    return modelResponse(result);
  } });
  assert.equal(outcome.status, 'published');
  assert.equal(requests.length, 2);
  assert.match(requests[1].input[1].content, /forbidden decision vocabulary/);
  assert.match(retryWarnings[0], /REVIEW_VALIDATION_FAILED/);
  assert.equal(mock.calls.filter(call => call.name === 'create' && call.args.body.startsWith(MARKER)).length, 1);
});

test('persistent invalid synthesis fails with useful diagnostics and never overwrites an older evaluation', async t => {
  const outputDirectory = fs.mkdtempSync(path.join(__dirname, '.review-test-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const mock = fixture();
  const previous = { id: 2, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nExisting complete evaluation` };
  mock.comments.push(previous);
  let requests = 0;
  await assert.rejects(run({ ...mock, context, outputDirectory, fetchImpl: async (url, options) => {
    requests++;
    const result = validResult(JSON.parse(JSON.parse(options.body).input[0].content));
    result.criteria[3].evidence_ids = ['E999'];
    return modelResponse(result);
  } }), error => error.code === 'REVIEW_VALIDATION_FAILED');
  assert.equal(requests, 2);
  assert.equal(previous.body, `${MARKER}\nExisting complete evaluation`);
  assert.equal(mock.calls.some(call => ['create', 'update', 'labels'].includes(call.name)), false);
  const saved = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'result.json')));
  assert.equal(saved.status, 'failed');
  assert.equal(saved.stage, 'synthesis');
  assert.equal(saved.diagnostic.request_id, 'req-unit-test');
  assert.match(saved.diagnostic.problems[0], /criteria\[3\].evidence_ids/);
});

test('HTTP authentication, quota and schema errors expose safe provider codes without retrying or echoing secrets', async () => {
  const mock = fixture();
  const bundle = await collect(mock.github);
  for (const [status, code] of [[401, 'invalid_api_key'], [429, 'insufficient_quota'], [400, 'invalid_json_schema']]) {
    let requests = 0;
    await assert.rejects(synthesize(bundle, {
      apiKey: 'unit-test-key', model: 'test', skill: '', policy: '',
      fetchImpl: async () => {
        requests++;
        return { ok: false, status, headers: new Headers({ 'x-request-id': 'req-diagnostic' }), json: async () => ({ error: {
          code, type: 'invalid_request_error', message: 'Invalid request parameter. Credential: unit-test-key; contact person@example.org',
        } }) };
      },
    }), error => error.code === 'OPENAI_HTTP_ERROR' && error.details.provider_code === code &&
      error.details.http_status === status && error.details.request_id === 'req-diagnostic' &&
      error.details.provider_message.includes('Invalid request parameter') &&
      !JSON.stringify(error).includes('unit-test-key') && !JSON.stringify(error).includes('person@example.org'));
    assert.equal(requests, 1);
  }
});

test('missing model credentials and incomplete responses cannot be reported as successful evaluations', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { process.env.OPENAI_API_KEY = oldKey; });
  const mock = fixture();
  await assert.rejects(run({ ...mock, context }), error => error.code === 'OPENAI_KEY_MISSING');
  assert.equal(mock.calls.some(call => ['create', 'update', 'labels'].includes(call.name)), false);
  process.env.OPENAI_API_KEY = oldKey;
  await assert.rejects(run({ ...fixture(), context, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
  }) }), error => error.code === 'OPENAI_INCOMPLETE' && error.message.includes('max_output_tokens'));
});

test('a mismatched publication readback fails instead of claiming that an evaluation was applied', async () => {
  const mock = fixture();
  mock.github.rest.issues.getComment = async () => ({ data: { body: 'A different comment', user: { login: 'github-actions[bot]' } } });
  await assert.rejects(run({ ...mock, context }), error => error.code === 'REVIEW_PUBLICATION_UNVERIFIED');
  assert.match(mock.summaries[0], /Review outcome: failed/);
  assert.equal(mock.summaries[0].includes('Verified issue comment'), false);
});
