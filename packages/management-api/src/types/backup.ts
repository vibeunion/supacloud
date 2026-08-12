export interface BackupInfo {
    id: string;
    type: 'full' | 'incr' | 'diff';
    timestamp: {
        start: number;
        stop: number;
    };
    size: number;
    database?: string;
}

export interface RestoreRequest {
    target: string; // Timestamp or LSN
}

export interface LogicalBackupIdentity {
    backup_id: string;
    project_ref: string;
    database: string;
    kind: 'logical-full';
    created_at: string;
    completed_at: string;
    bytes: number;
    sha256: string;
}

export interface LogicalBackupRestoreRequest {
    project_ref: string;
    backup_id: string;
    expected_sha256: string;
    confirmation: string;
}
