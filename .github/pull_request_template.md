<!--
Delete this comment block before submitting. Keep every section below --
if a section genuinely doesn't apply, say so explicitly (e.g. "N/A --
schema-only change") rather than deleting it.
-->

## Summary

<!-- What changed and why. Link the issue/PR this builds on if it stacks on one. -->

## Deliberately out of scope

<!-- What this PR does NOT do, and why -- especially anything a reviewer
     might expect to see here. Delete this section only if truly nothing
     was deferred. -->

## Verification

<!-- Exact commands run locally (build/test/typecheck/db:validate or
     equivalent) and their results. Note any known local-environment
     substitutions (e.g. turbo unavailable, using pnpm -r instead). -->

## Release / deployment impact

<!--
Required for any PR that touches staging/production infrastructure,
deployment workflows, environment configuration, or database migrations.
For a pure product-code PR with no deployment surface, write "N/A" on
each line below -- do not delete the section.
-->

- **Current main SHA at the time this PR was opened:**
- **Deployment impact:** <!-- e.g. "requires a new env var", "additive
  migration, no backfill", "no runtime change until X is also merged" -->
- **Rollback note:** <!-- how to revert this safely if it causes a
  problem after deploy, e.g. "revert this commit; migration is additive
  so no down-migration is needed" -->

## Test plan

- [ ] <!-- one checkbox per thing a reviewer/CI should verify -->
