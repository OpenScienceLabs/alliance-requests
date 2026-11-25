# Bot Workflows

Automation in this repository supports human review. Bots should surface useful
signals, apply routine labels, and reduce manual work. Bots must not replace
human judgement for affiliation approval, removal, or reactivation.

## Intake bot

Intake and preliminary reviews share the **Affiliation bot** workflow and the
same application detector. Intake handles opened, edited, reopened, transferred,
manually selected, and triage-labelled open applications.

Responsibilities:

- detect affiliation request issues;
- apply `type: affiliation-request` and `status: needs-triage` when needed;
- post an acknowledgement comment on new requests.

Routine label updates retry GitHub server errors up to three attempts, waiting
one and then two seconds between attempts. If server errors persist, the review
continues and records a warning in the workflow and report. Permission,
validation, and rate-limit errors still stop the run for investigation. Comment
creation is not automatically retried, to avoid duplicate public comments.

## Preliminary project-review bot

The **Affiliation bot** requests a review when an open application is created,
reopened, transferred into this repository, or receives `status: needs-triage`.
It recognizes `type: affiliation-request`, the `Affiliation request:` title
prefix, and the older `Incubation application:` prefix. Other issue types and
other label events are ignored, with a reason in the workflow logs.

To review an existing application, add `type: affiliation-request` if it lacks
the type label and either recognized title prefix, then add `status: needs-triage`.
If the triage label is already present, remove and re-add it. After an applicant
updates their issue, re-add the triage label to request another review; edits
alone run intake only. Reviewers manage conflicting status labels themselves. Older
headings such as `Current maintenance status`, `Maintenance context`, `Expected
OSL support`, and `Confirmations` are mapped to their current intake fields.

For a manual review without toggling a status label, open **Actions → Affiliation bot →
Run workflow**, select the default branch, and enter the issue number (for
example, `1`). The issue must be open and recognized as an application.
The run summary links the verified evaluation comment. Reports update the
existing bot comment, so a fresh evaluation does not add another issue reply.

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

1. Merge the workflows, scripts, and skill into the repository's default branch and
   enable GitHub Actions.
2. Ensure the standard type and status labels exist using
   `scripts/create-labels.sh` as described in [the maintainer guide](maintainer-guide.md).
3. Add an Actions repository secret named `OPENAI_API_KEY`. A successful review
   requires a validated AI evaluation; the secret is required.
4. Optionally set the Actions repository variable `OPENAI_MODEL`. The default is
   `gpt-4.1-mini`; use a model that supports the Responses API and strict structured
   output.
5. Run **Affiliation bot** manually with the application number, open a new
   application, or remove and re-add `status: needs-triage` to an existing one.
   Inspect the workflow run and its issue comment.

GitHub Actions does not load the local `.env` file. If the API secret is missing,
the model request fails, or synthesis remains invalid, the job fails and keeps
the previous public evaluation intact. The run summary and artifact show the
failure stage, safe error code, HTTP status/provider code when available, and
OpenAI request ID. Raw response bodies, invalid model drafts, and credentials
are never logged. Public evidence remains available in the failure artifact.

The model receives exact rubric and evidence-ID enums plus array-count limits.
One corrective request is allowed if content fails advisory-contract validation;
one retry is allowed for a transient model-service/network failure. Authentication,
quota and request-schema errors stop immediately with their provider codes.
API failures, refusals, incomplete output, invented evidence IDs, and invalid
schemas cannot produce a successful review. The workflow
uses the normal `GITHUB_TOKEN` with `contents: read` and `issues: write`; it does
not need a personal access token. Intake and review run in the same invocation:
labels applied with `GITHUB_TOKEN` do not start another workflow.
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

Success requires all twelve rubric areas, a valid advisory assessment, and a
successful readback of the saved issue comment matching the generated report.
Each run saves `report.md` and `result.json` in an artifact. The JSON outcome
distinguishes `published`, `preview`, `intake_only`, `skipped`, and `failed` and
records the reviewed revision, readiness, rubric count, and verified comment URL.

### Verify before merging

Run **Affiliation bot** on a candidate branch with the issue number. Non-default
branches automatically use read-only preview mode; selecting the `preview`
checkbox also enables it on `main`. Previews gather real public evidence, call
the configured model, validate all rubric areas, and render the complete report
in the run summary and artifact. They never add labels or create/edit comments.

For CI verification, add `ci: review-preview` to a same-repository pull request.
The **Repository checks → review-preview** job evaluates the pilot issue with
read-only GitHub permissions. `REVIEW_PREVIEW_ISSUE` selects its issue number
(default `1`). Fork PRs cannot run the job. This is opt-in because it uses the
configured OpenAI account. Verify a complete live preview before merging bot
changes, then check the verified public comment URL on the first production run.

This is preliminary screening, not the skill's expanded repository/lifecycle
investigation. It does not trace development cycles, inspect commit diffs or PR
reviews, fetch prior application discussions, validate external policies, or
independently test software. Reviewers must investigate critical gaps, human
ownership, scientific claims, and Alliance expectations. Intake adds the type
label and adds `status: needs-triage` only when no status exists. The assessment
does not change status or decision labels, close issues, or decide membership.

## Health-check bot

The **Maintenance** workflow supports manual health checks by selecting the
`health` task. Scheduled quarterly checks are opt-in: set the Actions repository
variable `ENABLE_PROJECT_HEALTH_CHECKS` to `true` only after adding a maintained
`data/affiliated-projects.json` with a non-empty `projects` array. Use the JSON
format documented by `scripts/check-affiliated-projects.py` and choose the
authoritative OSL project list before enabling the schedule.

The workflow fails with an explanatory report if the registry is missing,
malformed, or empty. Script errors are not suppressed. Individual project
findings remain advisory and require human review.

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
- `health-check-report.md` artifact, including available failure explanations.

The health check does not open issues, change labels, or remove affiliation.

## Stale/needs-info bot

The **Maintenance** workflow supports a manual `reminders` task. Weekly reminders
are off by default; set the Actions repository variable `ENABLE_STALE_REMINDERS`
to `true` to enable them.

Only open issues carrying both `type: affiliation-request` and
`status: needs-info` are eligible. After about 30 days without activity, the bot
posts a reminder and adds `bot: stale`. It preserves status labels, excludes
pull requests, and never closes issues automatically. Reviewers decide any
pause or closure; maintainer replies clear the stale marker.

Maintenance/removal reviews are excluded from these automated reminders. Human
reviewers may use the following follow-up schedule:

- Day 0: issue opened and maintainers pinged;
- Day 30: mark at risk if there is no response;
- Day 60: open removal review if baseline requirements remain unresolved; and
- Day 90: a human may remove the project from the public list.

## Link-check bot

The **Repository checks** workflow checks links on pull requests, pushes to
`main`, manual dispatch, and a weekly schedule. It checks Markdown files and
issue templates. `.lychee.toml` excludes explicit placeholder URLs such as
`github.com/org/project` and the example issue `123`; real broken links still
fail the job. It only requires read permissions.

On pull requests, main pushes, and manual runs, the same workflow validates YAML,
embedded JavaScript, issue forms, and Python/Node/shell script syntax, then runs
the bot and health-configuration tests. Tests use mocked APIs. The weekly run
only checks links, so its test job is intentionally skipped.

## Label check

Label-script syntax is checked in **Repository checks**. To list current labels,
run **Maintenance** manually with the `labels` task. Label creation is done with
`scripts/create-labels.sh` by a maintainer with appropriate permissions.

The former separate intake, link, label, health, and stale workflow files have
been consolidated into these three workflows. Keep their old disabled entries
disabled; they may remain visible in Actions history. Scheduled maintenance jobs
in the new workflow intentionally skip while their opt-in variables are unset.
