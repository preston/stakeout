BEGIN;

-- The old API and workers must be stopped before adopting this schema.
-- Queued checks are disposable; stale services are enqueued by the new worker.
DROP TABLE public.solid_queue_blocked_executions;
DROP TABLE public.solid_queue_claimed_executions;
DROP TABLE public.solid_queue_failed_executions;
DROP TABLE public.solid_queue_ready_executions;
DROP TABLE public.solid_queue_recurring_executions;
DROP TABLE public.solid_queue_scheduled_executions;
DROP TABLE public.solid_queue_jobs;
DROP TABLE public.solid_queue_pauses;
DROP TABLE public.solid_queue_processes;
DROP TABLE public.solid_queue_recurring_tasks;
DROP TABLE public.solid_queue_semaphores;
DROP TABLE public.schema_migrations;
DROP TABLE public.ar_internal_metadata;

COMMIT;
