-- Add project_tasks table for Saga state machine queue

CREATE TABLE IF NOT EXISTS project_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    task_type VARCHAR(50) NOT NULL, -- e.g., 'provision_db', 'provision_s3', 'provision_router', 'provision_gateway', 'cleanup_db', 'cleanup_s3'
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    payload JSONB DEFAULT '{}'::jsonb,
    error TEXT,
    retries INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient queue polling
CREATE INDEX IF NOT EXISTS idx_project_tasks_status_created ON project_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project_ref ON project_tasks(project_ref);
