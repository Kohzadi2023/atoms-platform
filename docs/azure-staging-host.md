# Dedicated Azure staging host

This is the Azure host implementation for Issue #22. It provisions a new,
single-host Docker target for Atoms while leaving the existing `LogiCount-VM`
and `LogiCount-RG` outside every template, workflow, resource name, and command.
The existing LogiCount host remains required by its own project and is not large
enough for the complete Atoms stack.

The template is intentionally limited to the approved boundary:

| Boundary | Value |
|---|---|
| Resource group | `atoms-staging-rg` |
| VM | `atoms-staging-vm` |
| Region | Canada Central |
| Size | `Standard_B2s_v2` (2 vCPU, 8 GiB) |
| OS | Ubuntu Server 24.04 LTS, Trusted Launch |
| OS disk | 64 GiB Standard SSD; deleted with the VM |
| Data disk | 128 GiB Standard SSD; detached on VM deletion and protected by a delete lock |
| Public ingress | TCP 80/443 and UDP 443 |
| Administration | SSH key only; one operator IPv4 CIDR between `/24` and `/32` |
| Monthly budget | CAD 80 resource-group budget with 50%, 80%, and 100% alerts |

`infra/azure/staging/main.bicep` is a resource-group-scope template. The workflow
can deploy it only to `atoms-staging-rg`; it cannot enumerate or mutate another
resource group. It creates only resources with the `atoms-staging` prefix or
tags and does not look up, resize, stop, start, attach to, or otherwise reference
LogiCount resources.

## Cost boundary

Azure budgets are monitoring and notification controls, not hard spending
limits. Microsoft documents that cost data can lag by 8–24 hours and crossing a
threshold does not stop resources. The workflow therefore fixes the template to
the approved SKU, region, and CAD 80 budget, but the operator must still review
the current subscription-specific estimate before the billable dispatch.

- [Azure budget behavior](https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets)
- [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/)

Deallocate the VM whenever staging will be unused for an extended period.
Managed disks and the static public IP can continue to incur charges while the
VM is deallocated. This repository intentionally has no automated destroy path.

## Host hardening and persistence

The resource group contains an isolated VNet, subnet, NSG, static Standard
public IP, NIC, VM, and managed data disk. The NSG denies all inbound traffic
except the three public ingress rules and SSH from the configured narrow CIDR.
Ubuntu also enables UFW with the same service ports, disables password and root
SSH login, enables unattended security updates, and installs Docker plus the
Compose plugin.

Cloud-init formats and mounts the data disk at `/var/lib/atoms`, then configures
Docker's data root as `/var/lib/atoms/docker`. The staging evidence, backup, and
secret directories are created with restrictive permissions. Removing the VM
detaches the data disk, and the `CanNotDelete` lock must be deliberately removed
before the disk can be deleted.

The VM has a system-assigned identity but receives no Azure data-plane role in
this template. No runtime credential, provider token, TLS private key, user
password, or SSH private key is included in cloud-init, Bicep, deployment
history, or source control.

## One-time OIDC bootstrap

The workflow uses GitHub OIDC and short-lived Azure tokens. It never creates or
stores a client secret. The repository includes an idempotent bootstrap command
so this setup can be completed from a local terminal instead of the Azure web
portal.

The trust is pinned to the immutable GitHub owner and repository IDs, as well as
the `phase3-staging` environment:

```text
repo:Kohzadi2023@149624604/atoms-platform@1319803321:environment:phase3-staging
```

This avoids name-recycling trust if the owner or repository name is later
renamed, transferred, or reused. The bootstrap verifies the IDs against GitHub
before changing anything and opts this repository into immutable OIDC subjects.

The workflow identity never receives a subscription-wide role. The bootstrap
creates the empty `atoms-staging-rg` control-plane container, then grants these
built-in roles only at that exact resource-group scope:

| Role | Reason |
|---|---|
| `Contributor` | Manage the dedicated VM, network, IP, and disks |
| `Locks Contributor` | Create the explicit delete lock on the data disk |
| `Cost Management Contributor` | Create and update the CAD 80 budget |

Consequently, the workflow identity has no inherited permission over
`LogiCount-RG` or `LogiCount-VM`.

References:

- [Deploy Bicep with GitHub Actions and OIDC](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-github-actions)
- [GitHub immutable OIDC subjects](https://docs.github.com/actions/reference/security/oidc#immutable-subject-claims)
- [Azure built-in roles](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles)
- [GitHub CLI environment secrets](https://cli.github.com/manual/gh_secret_set)

### Prerequisites

Install Node.js 24, pnpm, Azure CLI, GitHub CLI, and OpenSSH. Sign in once from
your own terminal; never paste a password, private key, OTP, client secret, or
device-login code into an issue, workflow input, repository file, or chat:

```bash
az login --use-device-code
gh auth login --hostname github.com
az account list --query "[?state=='Enabled'].{Name:name,Subscription:id,Default:isDefault}" --output table
```

Select the intended Pay-As-You-Go subscription UUID from the last command. The
bootstrap requires that UUID explicitly and refuses aliases such as `current`.
Use the current operator public IPv4 address with `/32` for SSH ingress and an
email address that should receive budget alerts.

### Read-only bootstrap plan

Run the bootstrap in `plan` mode first. It checks both authenticated accounts,
the pinned repository identity, the dedicated resource-group boundary, any
existing Entra application, role assignments, and GitHub OIDC configuration.
It does not change cloud or repository state:

```bash
pnpm staging:azure:oidc:bootstrap -- \
  --mode plan \
  --subscription-id <PAY_AS_YOU_GO_SUBSCRIPTION_UUID> \
  --budget-email <BUDGET_ALERT_EMAIL> \
  --ssh-source-cidr <CURRENT_PUBLIC_IPV4>/32 \
  --confirmation PLAN_DEDICATED_ATOMS_AZURE_OIDC
```

The default dedicated key path is `.ssh/atoms-staging-azure` below the current
user profile. Supply `--ssh-key-path <ABSOLUTE_PATH>` only when a different
dedicated key location is required.

### Apply control-plane bootstrap

After the plan succeeds, rerun with the independent apply acknowledgement:

```bash
pnpm staging:azure:oidc:bootstrap -- \
  --mode apply \
  --subscription-id <PAY_AS_YOU_GO_SUBSCRIPTION_UUID> \
  --budget-email <BUDGET_ALERT_EMAIL> \
  --ssh-source-cidr <CURRENT_PUBLIC_IPV4>/32 \
  --confirmation BOOTSTRAP_DEDICATED_ATOMS_AZURE_OIDC_WITHOUT_COMPUTE
```

Apply mode creates or verifies only the empty resource group, Entra
application/service principal, immutable federated credential, three
resource-group-scoped role assignments, local dedicated SSH key pair, and the
six environment secrets below. It is idempotent and aborts rather than taking
over ambiguous or mismatched existing state. It does not dispatch the host
workflow and does not create a VM, disk, public IP, domain, or other billable
resource.

The bootstrap stores these values as GitHub Environment secrets in
`phase3-staging`:

| Secret | Purpose |
|---|---|
| `AZURE_CLIENT_ID` | Entra application or managed-identity client ID |
| `AZURE_TENANT_ID` | Azure directory ID |
| `AZURE_SUBSCRIPTION_ID` | Target Pay-As-You-Go subscription ID |
| `AZURE_STAGING_SSH_PUBLIC_KEY` | Dedicated RSA or Ed25519 public key |
| `AZURE_STAGING_SSH_SOURCE_CIDR` | Current operator IPv4 range, preferably one `/32` |
| `AZURE_BUDGET_CONTACT_EMAIL` | Recipient for the CAD 80 budget alerts |

Never add the SSH private key, password, OTP, Azure client secret, or runtime
provider credentials. The validator reports only missing or invalid variable
names and never prints configured values.

## Read-only plan

Run `Azure staging host` manually from `main` with:

```text
mode=what-if
change_ticket=GH-22
confirmation=PLAN_DEDICATED_ATOMS_AZURE_STAGING
max_monthly_cost_cad=80
```

The first job validates the exact boundary and compiles Bicep without contacting
the subscription. The Azure job then runs `az deployment group what-if` against
only `atoms-staging-rg`, with resource-ID-only output. It cannot create or
modify a resource in this mode.

Confirm that the plan contains only `atoms-staging-rg` and its dedicated child
resources. Stop if any replacement, deletion, LogiCount resource, different
region, different SKU, or unexpected provider appears.

## Billable deployment

Only after the what-if result and current price estimate are accepted, dispatch
the same workflow with the independent provisioning acknowledgement:

```text
mode=deploy
change_ticket=GH-22
confirmation=PROVISION_DEDICATED_ATOMS_AZURE_STAGING
max_monthly_cost_cad=80
```

The job reruns what-if immediately before `az deployment group create`. A passing
run proves only that the Azure host was provisioned and reached a valid power
and provisioning state. It does not prove that application secrets, DNS, TLS,
Supabase, OpenAI, E2B, or the Atoms stack are ready.

## Application rollout boundary

The user does not currently own a deployment domain. Host provisioning can be
planned before domain registration, but the public application cannot pass the
existing staging contract until the web, API, storage, and wildcard preview DNS
records and an externally issued matching TLS certificate exist.

After the host is provisioned:

1. Register the selected domain within the separately approved CAD 20/year
   boundary; domain registration remains a separate financial action.
2. Point the exact web/API/storage names and wildcard preview name at the static
   Azure public IP.
3. Deliver runtime secrets and the TLS keypair through the approved mechanism;
   never place them in GitHub logs or the repository.
4. Check out the exact CI-approved full SHA under `/srv/atoms`.
5. Follow `docs/staging-deployment.md` for fail-closed preflight, persistence
   bootstrap, rollout, authenticated smoke, and recovery rehearsal.

The Azure-provided `cloudapp.azure.com` FQDN is useful for administrative host
identification only. It cannot replace the exact multi-host and wildcard domain
contract required by the application.
