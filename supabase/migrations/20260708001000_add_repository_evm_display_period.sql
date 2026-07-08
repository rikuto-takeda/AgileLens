ALTER TABLE public.repositories
ADD COLUMN IF NOT EXISTS evm_display_start_date DATE,
ADD COLUMN IF NOT EXISTS evm_display_end_date DATE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'repositories_evm_display_period_check'
    ) THEN
        ALTER TABLE public.repositories
        ADD CONSTRAINT repositories_evm_display_period_check
        CHECK (
            (evm_display_start_date IS NULL AND evm_display_end_date IS NULL)
            OR (
                evm_display_start_date IS NOT NULL
                AND evm_display_end_date IS NOT NULL
                AND evm_display_start_date <= evm_display_end_date
                AND evm_display_end_date <= evm_display_start_date + 89
            )
        );
    END IF;
END $$;
