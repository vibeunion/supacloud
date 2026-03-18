import type { PageServerLoad } from './$types';
import { db } from '$management/db';
import { projectService } from '$management/services';

export const load: PageServerLoad = async ({ url }) => {
    const projectRef = url.searchParams.get('ref') || 'default';
    
    try {
        const projects = await projectService.listProjects();
        const project = projects.find(p => p.ref === projectRef) || projects[0];
        
        if (!project) {
            return { users: [], count: 0 };
        }

        const dbName = project.db_name || `supa_${project.ref}`;
        
        // Fetch Users from auth.users (Standard Supabase Structure)
        const usersResult = await db.executeQuery(dbName, `
            SELECT id, email, phone, last_sign_in_at, created_at, invited_at, confirmed_at, raw_user_metadata
            FROM auth.users
            ORDER BY created_at DESC;
        `);

        return {
            project,
            users: usersResult.rows.map((r: any) => ({
                id: r.id,
                email: r.email || r.phone || 'Anonymous',
                last_sign_in_at: r.last_sign_in_at,
                created_at: r.created_at,
                metadata: r.raw_user_metadata || {}
            })),
            count: usersResult.rowCount
        };
    } catch (err) {
        console.error('Failed to load auth users:', err);
        return { users: [], count: 0 };
    }
};
