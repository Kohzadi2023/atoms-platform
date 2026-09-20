# Reference architecture: agency client portal (draft)

Status: **draft proposal for the team to change or reject.** Nothing here is implemented and no code depends on it. It exists because the 2026-09-19 team review fixed Q1 on this one template and listed "standardize the reference architecture" as an action item with no owner. Anything marked **open** needs a decision from a person.

It is meant to unblock three things that all wait on the same definition: the capability set for project-type routing (#101), the acceptance journey for the acceptance runner (#99), and what a design partner is promised.

## What it is

A portal an agency gives its own clients. The agency's clients sign in and see their projects, the deliverables shared with them, and what is waiting on their approval. The agency's staff manage clients, projects and deliverables. Each client sees only their own data.

It is an operational tool, not a marketing site. That is why it does not need market research, SEO or growth copy (see "Capabilities").

## Users and roles

| Role | Can |
|---|---|
| Agency admin | Manage staff, clients, projects and deliverables; see everything for the agency |
| Agency member | Manage the clients and projects they are assigned to |
| Client | See their own projects and deliverables, comment, approve or request changes |

**Open:** whether clients invite their own colleagues (a second client user per client), and whether staff can act as a client to see what they see.

## Data model

Everything hangs off a tenant (the agency), and a client belongs to exactly one agency.

- `Agency`, `User` (with a role), `Client` (belongs to an agency, has client users)
- `Project` (belongs to a client), `Milestone` (belongs to a project, has a status and a due date)
- `Deliverable` (belongs to a project: title, file reference, status `DRAFT`, `SHARED`, `APPROVED`, `CHANGES_REQUESTED`)
- `Comment` (on a deliverable, with author and timestamp), `Approval` (who approved which deliverable version and when)

**Isolation is the hard requirement.** Tenant isolation is enforced in the database with row-level security, not only in application code: David's data-policy report already has an `rlsModels` field, and the platform's own control plane scopes access by workspace membership. A generated portal that filters by client only in route handlers is not acceptable.

**Open:** invoices. Showing them means integrating a billing tool or storing amounts; leaving them out of v1 is simpler.

## Screens and routes

- Client: dashboard (projects and what awaits them), project page (milestones, deliverables), deliverable page (view, comment, approve or request changes)
- Staff: client list, client page, project editor, deliverable upload and sharing, activity feed
- Sign-in, sign-out, invitation acceptance

Uploads are a risk surface of their own (size, type, malware). **Open:** whether v1 stores files itself or only links to a file the agency keeps elsewhere.

## Capabilities it needs

Mapped to the platform's agents:

| Capability | Agent | Needed |
|---|---|---|
| Product requirements | Emma | yes |
| Task planning | Mike | yes |
| Architecture and schema | Bob | yes |
| Application code | Alex | yes |
| Migrations, seed data, data policy | David | yes |
| Market research | Sophia | no |
| SEO | Sarah | no |
| Growth copy | Adrian | no |

So the required set is Emma, Mike, Bob, Alex and David, and the three premium agents are not needed. Today those three run only on a `PRO` or `MAX` workspace and are skipped on `FREE`, so **a partner workspace can stay on `FREE`**. The `CLIENT_PORTAL` project type now enforces this set whatever the plan is (`PROJECT_TYPE_AGENTS` in `apps/orchestrator-worker/src/project-type.ts`); the set itself is still a proposal until confirmed.

## What "working" means (acceptance journey, for #99)

The minimum the acceptance runner should prove for this template, in order of importance:

1. **Isolation.** Client A signs in and cannot see, open by URL, or fetch through the API anything belonging to client B. This is the check that matters most, and a successful build proves nothing about it.
2. A staff user creates a client, a project and a deliverable, and shares the deliverable.
3. The invited client signs in, sees only that project, comments, and approves the deliverable.
4. The approval shows to staff with who and when.
5. A signed-out visitor reaches nothing except the sign-in page.

Until this exists, a generated portal can only be described as a **Validated Preview**.

## Constraints from the platform

- Stack is fixed by the agents' shared rules: Next.js, React, TypeScript, Tailwind, Prisma, PostgreSQL. A different stack is out of scope.
- The validation sandbox is configured to reach only the package registries (the live egress probe has not yet confirmed this), so the portal must not depend on an external service at build or test time.
- Generated code runs only inside the sandbox during validation; the customer approves the plan before any code is generated, and sees the derived requirements first.

## Not in v1 (proposed)

Invoices and payments, email notifications, a mobile app, custom branding beyond a name and logo, single sign-on, audit export.

## Decisions needed

1. Is this the right scope and role model, or should it be smaller?
2. The **open** items above: colleague invitations, staff impersonation, invoices, file storage.
3. Confirm the capability set (Emma, Mike, Bob, Alex, David) and that partner workspaces stay on `FREE`.
4. Who owns this definition. It should have one owner, because the acceptance journey and the routing table both derive from it.
