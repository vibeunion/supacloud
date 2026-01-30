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
