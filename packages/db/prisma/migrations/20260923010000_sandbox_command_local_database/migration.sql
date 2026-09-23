-- G3 (docs/adr/production-execution-gate.md), issue #130: three new optional
-- sandbox validation steps -- db-start, db-migrate, db-seed -- that bring up the
-- local database baked into the validation template before preview-start. Purely
-- additive: existing rows and every other step name are unaffected, and nothing
-- writes these values until ACCEPTANCE_CHECK=required is set on the worker.

-- AlterEnum
ALTER TYPE "SandboxCommandName" ADD VALUE 'DB_START';
ALTER TYPE "SandboxCommandName" ADD VALUE 'DB_MIGRATE';
ALTER TYPE "SandboxCommandName" ADD VALUE 'DB_SEED';
