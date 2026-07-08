ALTER TABLE public.issues
ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(6,2);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'issues'
          AND column_name = 'story_point'
    ) THEN
        EXECUTE '
            UPDATE public.issues
            SET estimated_hours = CASE
                WHEN estimated_hours IS NOT NULL THEN estimated_hours
                WHEN story_point IS NOT NULL AND story_point > 0 THEN 0.5
                ELSE 0.5
            END
        ';
    ELSE
        UPDATE public.issues
        SET estimated_hours = COALESCE(estimated_hours, 0.5);
    END IF;
END $$;

ALTER TABLE public.issues
ALTER COLUMN estimated_hours SET DEFAULT 0.5,
ALTER COLUMN estimated_hours SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'issues_estimated_hours_non_negative'
    ) THEN
        ALTER TABLE public.issues
        ADD CONSTRAINT issues_estimated_hours_non_negative
        CHECK (estimated_hours >= 0);
    END IF;
END $$;

ALTER TABLE public.repositories
DROP CONSTRAINT IF EXISTS repositories_point_unit_price_non_negative,
DROP COLUMN IF EXISTS point_unit_price;

ALTER TABLE public.sprints
DROP CONSTRAINT IF EXISTS sprints_total_story_points_non_negative,
DROP COLUMN IF EXISTS total_story_points;

ALTER TABLE public.issues
DROP CONSTRAINT IF EXISTS issues_story_point_non_negative,
DROP COLUMN IF EXISTS story_point;
