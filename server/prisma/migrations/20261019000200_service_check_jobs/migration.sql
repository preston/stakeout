BEGIN;

CREATE TABLE public.service_check_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_id uuid NOT NULL,
    status text DEFAULT 'pending' NOT NULL,
    available_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    locked_by text,
    lease_expires_at timestamp(6) with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    last_error text,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp(6) with time zone,
    CONSTRAINT service_check_jobs_pkey PRIMARY KEY (id),
    CONSTRAINT service_check_jobs_service_id_fkey FOREIGN KEY (service_id)
      REFERENCES public.services(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT service_check_jobs_status_check CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    CONSTRAINT service_check_jobs_attempts_check CHECK (attempts >= 0 AND max_attempts > 0)
);

CREATE UNIQUE INDEX service_check_jobs_active_service_id
  ON public.service_check_jobs (service_id) WHERE status IN ('pending', 'running');
CREATE INDEX service_check_jobs_claim_idx
  ON public.service_check_jobs (status, available_at, created_at);

-- Recover discarded legacy work exactly once during the maintenance cutover.
-- Existing timestamps are UTC even though Rails used timestamp without zone.
INSERT INTO public.service_check_jobs(service_id)
  SELECT id FROM public.services
  WHERE checked_at IS NULL OR checked_at < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute'
  ON CONFLICT(service_id) WHERE status IN ('pending', 'running') DO NOTHING;

COMMIT;
