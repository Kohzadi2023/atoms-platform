# Staging deploy runbook

How a merged change reaches the staging environment (`www.genesisco.io`, `api.genesisco.io`).

**Merging to `main` does not deploy anything.** Every workflow that touches Azure is
`workflow_dispatch`. Each service is built into the staging registry by hand and then rolled out
as a new Container App revision. Three scripts in `deploy/staging/` do that.

| Service | Container App | Script |
|---|---|---|
| Web | `atoms-staging-web` | `entra-web-cutover.ps1` |
| Control API | `atoms-staging-control-api` | `deploy-backend-image.ps1 -Service control-api` |
| Worker | `atoms-staging-worker` | `deploy-backend-image.ps1 -Service orchestrator-worker` |

All three run against subscription `Atoms-Staging` (`2ac8ed24-166b-4325-89dc-829d64391ce9`),
resource group `atoms-staging-rg`, registry `atomsstaging91ce9`, and refuse to continue on the
legacy subscription.

## Before you start

- PowerShell 7 (`pwsh`), `git` and the Azure CLI, signed in to the staging profile:
  `AZURE_CONFIG_DIR=%USERPROFILE%\.azure-atoms`. The scripts set that variable themselves.
- A **clean checkout** at the exact commit you want to deploy. The scripts refuse a dirty tree and
  refuse a commit other than the one you name with `-ExpectedSourceSha` (the full 40 characters).
  Use `git rev-parse origin/main` for the latest `main`.
- CI on that commit is green.

## What needs deploying, and in which order

Each service image contains the workspace packages it depends on (from each `package.json`):

| Changed | Deploy |
|---|---|
| `apps/web` | web |
| `packages/contracts` | all three (web, Control API and worker all depend on it) |
| `apps/control-api` | Control API |
| `apps/orchestrator-worker`, `packages/database-provider`, `packages/preview` | worker |
| `packages/db`, `packages/queue-connection`, `packages/model-gateway`, `packages/quality`, `packages/sandbox-provider`, `packages/storage-provider`, `packages/agents` | Control API and worker |
| `packages/memory` | neither (no service depends on it yet) |
| the lockfile or `pnpm-workspace.yaml` | check all three; a bump of a package they share reaches each image that uses it |

- **Control API before web** when a page calls a route that is new. Otherwise the page asks an API
  that does not have the route yet and gets a 404.

## Deploy

Replace `$SHA` with the commit, for example `$SHA = git rev-parse origin/main`.

```powershell
# Check first. Changes nothing, builds nothing; prints the image, the running image and the
# rollback command.
./deploy/staging/deploy-backend-image.ps1 -Service control-api -ExpectedSourceSha $SHA -PlanOnly

./deploy/staging/deploy-backend-image.ps1 -Service control-api         -ExpectedSourceSha $SHA
./deploy/staging/deploy-backend-image.ps1 -Service orchestrator-worker -ExpectedSourceSha $SHA
./deploy/staging/entra-web-cutover.ps1                                  -ExpectedSourceSha $SHA
```

Each backend run: locks the subscription, checks the tree and commit, builds
`<repository>:main-<first 12 characters of the commit>` in the registry, rolls it out, waits for the
new revision to become ready, then reads the Control API's `/readyz`. The web script builds
`web:entra-<first 12 characters>`.

The web script reads the public origins that get baked into the image from Azure: the Control API's
custom domain and the preview gateway's `PREVIEW_BASE_DOMAIN`. Do not pass the raw
`*.azurecontainerapps.io` host names; the script refuses them. Override with `-ControlApiOrigin` and
`-PreviewBaseDomain` only if the environment really changed.

## Check the result

- **Control API:** `https://api.genesisco.io/readyz` returns `"status":"ready"` and
  `"platformReady":true`. The script checks this for you.
- **Worker:** the same `/readyz` shows `"workerState":"reporting"`. The script checks this after a
  worker deploy.
- **Web:** the footer of every page reads `Atoms v<version in package.json>`, `/admin` answers 200,
  and the response header `Content-Security-Policy` still names `https://api.genesisco.io` and
  `https://preview.genesisco.io`.
- `executionReady:false` and `inconsistent:true` in `/readyz` are the normal state while the
  live-evidence gates G5 and G7 are open. They do not block runs and the scripts do not judge them.

Sign-in, the admin table with real data and a real run are not covered by any script. Check them in
the browser.

## Roll back

Each backend script prints the exact command, using the image that was running before. For the web
app, note the running image first (`az containerapp show ... --query
properties.template.containers[0].image`). A rollback is always:

```powershell
az containerapp update --subscription 2ac8ed24-166b-4325-89dc-829d64391ce9 `
  --resource-group atoms-staging-rg --name <app> --image <previous image>
```

The apps run in single-revision mode, so a new revision that never becomes ready leaves the
previous one serving; the backend script then stops with the rollback command. Re-deploying the
image an app already runs is allowed and leaves no earlier image to return to.

## Before deploying code that was written a while ago

The scripts deploy code only. They do not apply database migrations or change environment
variables, so check both against the commit that is currently deployed (the tag names it):

```powershell
# migrations added since the deployed commit
git diff --name-only --diff-filter=A <deployed sha> HEAD -- packages/db/prisma/migrations
# environment keys added or removed in a service's schema
git diff <deployed sha> HEAD -- apps/orchestrator-worker/src/main.ts
```

Applying migrations to the staging database is not covered by these scripts.

## Known traps

- `az acr build` crashes on Windows with `UnicodeEncodeError: 'charmap'` while streaming the build
  log whenever the output is not a console. `az.cmd` starts Python in isolated mode, so
  `PYTHONUTF8` does not help. The scripts build with `--no-logs`, which waits for the build, and
  then confirm the image tag was rewritten.
- Every pull request must raise the root `package.json` version (the `version-bump` CI check). It is
  the number shown in the web footer, which is how you tell what is deployed.
