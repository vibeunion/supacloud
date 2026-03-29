import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request }) => {
    const { db } = await import('$management/db');
    const { projectService } = await import('$management/services');
    const { projectRef, query } = await request.json();
    
    try {
        const projects = await projectService.listProjects();
        const project = projects.find(p => p.ref === projectRef) || projects[0];
        
        if (!project) {
            return json({ error: 'Project not found' }, { status: 404 });
        }

        const dbName = (project as unknown as Record<string, unknown>).db_name as string || `supa_${project.ref}`;
        const result = await db.executeQuery(dbName, query);
        
        return json({
            data: result.rows,
            rowCount: result.rowCount,
            command: result.command
        });
    } catch (err: unknown) {
        console.error('SQL Query Error:', err);
        return json({ error: (err instanceof Error ? err.message : String(err)) }, { status: 500 });
    }
};
