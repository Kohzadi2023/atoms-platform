# Revenue & GTM provider interfaces

`@atoms/revenue` defines the provider-neutral adapter interfaces Sophia's
Revenue & GTM layer will use: `ProspectingProvider` (Apollo-shaped prospect
discovery/enrichment) and `CrmProvider` (HubSpot-shaped contact/company/deal
sync and pipeline stages).

**This package is type definitions only.** As of this writing:

- There is no HTTP call to Apollo or HubSpot anywhere in this package.
- There is no credential handling, OAuth flow, or API key resolution.
- There is no webhook receiver, signature verification, or inbox for
  inbound CRM/provider events.
- There is no reusable exported mock -- consumers define their own local
  fake implementing these interfaces for tests, the same convention
  `@atoms/database-provider` uses for `DatabaseProvider`.

A concrete Apollo adapter, a concrete HubSpot adapter, live-credential
integration tests, and a webhook inbox are separate future increments, not
covered by this package.
