-- G3 (docs/adr/production-execution-gate.md): a new optional sandbox validation
-- step, "acceptance", that runs after a passing preview-health. Purely additive:
-- existing rows and every other step name are unaffected, and nothing writes this
-- value until ACCEPTANCE_CHECK=required is set on the worker.

-- AlterEnum
ALTER TYPE "SandboxCommandName" ADD VALUE 'ACCEPTANCE';
