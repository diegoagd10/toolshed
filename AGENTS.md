# Working in this repository

Work is done only when `npm run check` exits 0. It runs format, lint, types, build, tests and coverage. Run it after the last edit and keep working until it passes.

- Coverage must be 100%. When it fails, read `Uncovered Lines` and write an integration test that reaches those lines, or delete code that nothing can reach.
- A covered line is not a checked line. Each test asserts what the caller sees.
- Do not lower a threshold, exclude a file, disable a rule, or skip or weaken a test to pass. If a gate looks wrong, stop and ask the owner.
- Write a unit test only when no integration test can reach a path.
- Lint rules have no tests. Add the rule, see it fail, fix what it reports and run it again.

The conventions are in `README.md` and the phases are in `PLAN.md`.

## Pull requests

After each push, wait until every check of the pull request finishes. If one fails, fix it and push again.

Tell the owner in the chat "PR #<number> is ready to merge", with its link and commit, only when all of this is true for the latest commit:

- Every check passed. None failed, was cancelled or is pending.
- There are no conflicts with `main`, and the pull request is not a draft.
- No review comment is unresolved.

If something in the description still needs a decision from the owner, say it in the same message. If the pull request cannot get there, say what blocks it. Never merge it without the owner's written approval of that merge.
