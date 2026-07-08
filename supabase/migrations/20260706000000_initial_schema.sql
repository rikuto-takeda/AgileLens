-- AgileLens MVP initial schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = timezone('utc'::text, now());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    github_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    github_access_token TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE TABLE public.repositories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    github_repo_id TEXT UNIQUE NOT NULL,
    repo_name TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    full_name TEXT GENERATED ALWAYS AS (owner_name || '/' || repo_name) STORED,
    hourly_wage INT DEFAULT 0 NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT repositories_hourly_wage_non_negative CHECK (hourly_wage >= 0)
);

CREATE TABLE public.sprints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    github_milestone_id TEXT,
    title TEXT NOT NULL,
    start_date DATE,
    due_on DATE,
    cycle_days INT DEFAULT 14 NOT NULL,
    state TEXT DEFAULT 'open' NOT NULL,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT sprints_state_check CHECK (state IN ('open', 'closed')),
    CONSTRAINT sprints_cycle_days_positive CHECK (cycle_days > 0),
    CONSTRAINT sprints_date_order CHECK (start_date IS NULL OR due_on IS NULL OR start_date <= due_on),
    UNIQUE (repository_id, github_milestone_id)
);

CREATE TABLE public.issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repository_id UUID NOT NULL REFERENCES public.repositories(id) ON DELETE CASCADE,
    sprint_id UUID REFERENCES public.sprints(id) ON DELETE SET NULL,
    github_issue_id TEXT,
    github_issue_number INT,
    title TEXT NOT NULL,
    state TEXT DEFAULT 'open' NOT NULL,
    kanban_column TEXT DEFAULT 'Backlog' NOT NULL,
    estimated_hours NUMERIC(6,2) DEFAULT 0.5 NOT NULL,
    labels JSONB DEFAULT '[]'::jsonb NOT NULL,
    source TEXT DEFAULT 'github' NOT NULL,
    assignee_username TEXT,
    assignee_avatar_url TEXT,
    github_html_url TEXT,
    closed_at TIMESTAMP WITH TIME ZONE,
    synced_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT issues_state_check CHECK (state IN ('open', 'closed')),
    CONSTRAINT issues_kanban_column_check CHECK (kanban_column IN ('Backlog', 'In Progress', 'Done')),
    CONSTRAINT issues_estimated_hours_non_negative CHECK (estimated_hours >= 0),
    CONSTRAINT issues_source_check CHECK (source IN ('github', 'manual', 'claude')),
    UNIQUE (repository_id, github_issue_id),
    UNIQUE (repository_id, github_issue_number)
);

CREATE TABLE public.evm_daily_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sprint_id UUID NOT NULL REFERENCES public.sprints(id) ON DELETE CASCADE,
    recorded_date DATE NOT NULL,
    planned_value INT DEFAULT 0 NOT NULL,
    earned_value INT DEFAULT 0 NOT NULL,
    actual_cost INT DEFAULT 0 NOT NULL,
    daily_working_hours NUMERIC(5,2) DEFAULT 0 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    CONSTRAINT evm_planned_value_non_negative CHECK (planned_value >= 0),
    CONSTRAINT evm_earned_value_non_negative CHECK (earned_value >= 0),
    CONSTRAINT evm_actual_cost_non_negative CHECK (actual_cost >= 0),
    CONSTRAINT evm_daily_working_hours_non_negative CHECK (daily_working_hours >= 0),
    UNIQUE (sprint_id, recorded_date)
);

CREATE INDEX idx_repositories_user_id ON public.repositories(user_id);
CREATE INDEX idx_repositories_full_name ON public.repositories(full_name);
CREATE INDEX idx_sprints_repository_id ON public.sprints(repository_id);
CREATE INDEX idx_sprints_repository_state ON public.sprints(repository_id, state);
CREATE INDEX idx_issues_repository_id ON public.issues(repository_id);
CREATE INDEX idx_issues_sprint_id ON public.issues(sprint_id);
CREATE INDEX idx_issues_board ON public.issues(repository_id, sprint_id, kanban_column);
CREATE INDEX idx_issues_state ON public.issues(repository_id, state);
CREATE INDEX idx_issues_labels ON public.issues USING GIN(labels);
CREATE INDEX idx_evm_daily_snapshots_sprint_date ON public.evm_daily_snapshots(sprint_id, recorded_date);

CREATE TRIGGER set_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_repositories_updated_at
BEFORE UPDATE ON public.repositories
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_sprints_updated_at
BEFORE UPDATE ON public.sprints
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_issues_updated_at
BEFORE UPDATE ON public.issues
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_evm_daily_snapshots_updated_at
BEFORE UPDATE ON public.evm_daily_snapshots
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evm_daily_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
ON public.users FOR SELECT
USING (id = auth.uid());

CREATE POLICY "Users can insert own profile"
ON public.users FOR INSERT
WITH CHECK (id = auth.uid());

CREATE POLICY "Users can update own profile"
ON public.users FOR UPDATE
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

CREATE POLICY "Repository owners can read repositories"
ON public.repositories FOR SELECT
USING (user_id = auth.uid());

CREATE POLICY "Repository owners can insert repositories"
ON public.repositories FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Repository owners can update repositories"
ON public.repositories FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Repository owners can delete repositories"
ON public.repositories FOR DELETE
USING (user_id = auth.uid());

CREATE POLICY "Repository owners can read sprints"
ON public.sprints FOR SELECT
USING (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = sprints.repository_id
          AND r.user_id = auth.uid()
    )
);

CREATE POLICY "Repository owners can write sprints"
ON public.sprints FOR ALL
USING (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = sprints.repository_id
          AND r.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = sprints.repository_id
          AND r.user_id = auth.uid()
    )
);

CREATE POLICY "Repository owners can read issues"
ON public.issues FOR SELECT
USING (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = issues.repository_id
          AND r.user_id = auth.uid()
    )
);

CREATE POLICY "Repository owners can write issues"
ON public.issues FOR ALL
USING (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = issues.repository_id
          AND r.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.repositories r
        WHERE r.id = issues.repository_id
          AND r.user_id = auth.uid()
    )
);

CREATE POLICY "Repository owners can read evm snapshots"
ON public.evm_daily_snapshots FOR SELECT
USING (
    EXISTS (
        SELECT 1
        FROM public.sprints s
        JOIN public.repositories r ON r.id = s.repository_id
        WHERE s.id = evm_daily_snapshots.sprint_id
          AND r.user_id = auth.uid()
    )
);

CREATE POLICY "Repository owners can write evm snapshots"
ON public.evm_daily_snapshots FOR ALL
USING (
    EXISTS (
        SELECT 1
        FROM public.sprints s
        JOIN public.repositories r ON r.id = s.repository_id
        WHERE s.id = evm_daily_snapshots.sprint_id
          AND r.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1
        FROM public.sprints s
        JOIN public.repositories r ON r.id = s.repository_id
        WHERE s.id = evm_daily_snapshots.sprint_id
          AND r.user_id = auth.uid()
    )
);
