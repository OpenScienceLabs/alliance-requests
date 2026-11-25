# Bot Workflows

Automation in this repository supports human review. Bots should surface useful
signals, apply routine labels, and reduce manual work. Bots must not replace
human judgement for affiliation approval, removal, or reactivation.

## Intake bot

Triggered when an issue is opened, edited, or reopened.

Responsibilities:

- detect affiliation request issues;
- apply `type: affiliation-request` and `status: needs-triage` when needed;
- post an acknowledgement comment on new requests.

## Preliminary project-review bot

The **Affiliation preliminary review** workflow runs when an open affiliation
request is created or when someone adds `status: needs-triage` to it. It recognizes
`type: affiliation-request` or the `Affiliation request:` title prefix. Other
issue types and other label events are ignored.

To review an existing application, add `type: affiliation-request` if it lacks
the type label and title prefix, then add `status: needs-triage`. If the triage
label is already present, remove and re-add it. After an applicant updates their
issue, re-add the triage label to request another review; edits alone only run
the intake workflow. Reviewers manage any conflicting status labels themselves.

The bot updates one bot-owned preliminary-review comment, gathering fresh evidence
on each run. Concurrent creation/label events are serialized. It checks form
completeness and samples public GitHub repository metadata, a pinned default-branch
revision, source inventory, up to nine policy/source/test/build/CI files, ten
commit summaries from the past year, five recent issue/PR entries (PRs excluded
from the report), three releases, and one CI run at the reviewed revision. File
text is limited to 6,000 characters per file; files above 64 KB are skipped.
Application text is limited to 14,000 characters. Actual evidence and unavailable
reads are listed in the report. Repository access failures mean unknown evidence.

When configured, OpenAI synthesizes the evidence using
[the project-review skill](../.agents/skills/project-review/SKILL.md), its strict
automated output contract in section 9, and the adopted
[affiliation criteria](criteria.md). All twelve rubric areas are included;
insufficient evidence is flagged for human review. The skill's proposed baselines
do not override adopted policy. Reports link the guideline version and repository
commit used for the review.

Setup:

1. Merge the workflow, script, and skill into the repository's default branch and
   enable GitHub Actions.
2. Ensure the standard type and status labels exist using
   `scripts/create-labels.sh` as described in [the maintainer guide](maintainer-guide.md).
3. Add an Actions repository secret named `OPENAI_API_KEY` to enable AI synthesis.
4. Optionally set the Actions repository variable `OPENAI_MODEL`. The default is
   `gpt-4.1-mini`; use a model that supports the Responses API and strict structured
   output.
5. Open an affiliation request or remove and re-add `status: needs-triage` to an
   existing open application. Inspect the **Affiliation preliminary review** run
   and its issue comment.

GitHub Actions does not load the local `.env` file. Without the API secret, or if
synthesis fails, the bot still publishes an evidence-only report and explicitly
requests human review. API failures, refusals, incomplete output, invented
evidence IDs, and invalid schemas cannot produce an AI assessment. The workflow
uses the normal `GITHUB_TOKEN` with `contents: read` and `issues: write`; it does
not need a personal access token. The creation trigger runs independently of
intake because labels applied with `GITHUB_TOKEN` do not start another workflow.
See GitHub's [triggering a workflow documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).

Only public repository evidence is collected through GitHub's API. Applicant
scripts, dependencies, builds, tests, and workflows are never executed. External
websites and applicant policy links are not fetched. The model has no tools,
receives evidence as untrusted input separately from the trusted skill, and uses
the [Responses API structured-output format](https://developers.openai.com/api/docs/guides/structured-outputs)
with response storage disabled. Email addresses, common credential patterns, and
known runtime tokens are redacted before synthesis and publication; this is not a
comprehensive secret scan. Public text is escaped to prevent unintended Markdown,
links, and mentions. Only the bot's own report comment is updated.

This is preliminary screening, not the skill's expanded repository/lifecycle
investigation. It does not trace development cycles, inspect commit diffs or PR
reviews, fetch prior application discussions, validate external policies, or
independently test software. Reviewers must investigate critical gaps, human
ownership, scientific claims, and Alliance expectations. The bot never changes
labels, closes issues, records a final disposition, or decides membership.

## Health-check bot

Runs quarterly and through manual dispatch.

Checks may include:

- repository reachable;
- repository public;
- repository not archived;
- license file exists;
- Code of Conduct exists;
- README exists;
- optional `CONTRIBUTING.md` exists;
- optional `SECURITY.md` exists;
- last push date;
- issue or pull-request activity;
- listed URL works; and
- maintainer/user exists where detectable.

Outputs:

- Markdown summary in workflow logs;
- optional `health-check-report.md` artifact;
- future maintenance review issues for failures; and
- labels such as `status: at-risk` or `check: license` when a human review is
  needed.

The bot should never remove affiliation without human review.

## Stale/needs-info bot

For request issues:

- after about 30 days waiting on applicant information, comment and keep or apply
  `status: needs-info`/`status: paused`;
- after about 60 days waiting on applicant information, close as incomplete or
  keep paused; and
- allow applicants to reopen or reapply later.

For maintenance reviews:

- Day 0: issue opened and maintainers pinged;
- Day 30: mark at risk if there is no response;
- Day 60: open removal review if baseline requirements remain unresolved; and
- Day 90: a human may remove the project from the public list.

## Link-check bot

Runs weekly, manually, and on pull requests. It checks links in Markdown files
and issue templates. Link failures should be reviewed before making policy or
listing changes.

## Label check

The label check workflow is manual. It verifies that the label creation script is
syntactically valid and lists current repository labels. Label creation is done
with `scripts/create-labels.sh` by a maintainer with appropriate permissions.
