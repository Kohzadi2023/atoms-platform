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

`infra/azure/staging/main.bicep` creates only resources with the `atoms-staging`
prefix or tags. It does not look up, resize, stop, start, attach to, or otherwise
reference LogiCount resources.

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

The workflow uses GitHub OIDC and short-lived Azure tokens. Do not create or
store a client secret. Before the first workflow run, create a Microsoft Entra
application or user-assigned managed identity with a federated credential for:

```text
repo:Kohzadi2023/atoms-platform:environment:phase3-staging
```

The identity needs `Contributor` for the subscription deployment and Cost
Management permission to create the resource-group budget. Follow Microsoft's
OIDC setup guidance and keep the role assignment limited to this staging
purpose:

- [Deploy Bicep with GitHub Actions and OIDC](https://learn.microsoft.com/azure/azure-resource-manager/bicep/deploy-github-actions)

Add these values as GitHub Environment secrets in `phase3-staging`:

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
the subscription. The Azure job then runs `az deployment sub what-if` with
resource-ID-only output. It cannot create or modify a resource in this mode.

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

The job reruns what-if immediately before `az deployment sub create`. A passing
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
