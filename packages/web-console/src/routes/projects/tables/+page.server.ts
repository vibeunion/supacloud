import type { PageServerLoad } from './$types';
import { db } from '$management/db';
import { projectService } from '$management/services';

export const load: PageServerLoad = async ({ url }) => {
    const projectRef = url.searchParams.get('ref') || 'default';
    
    try {
        const projects = await projectService.listProjects();
        const foundProject = projects.find(p => p.ref === projectRef) || projects[0];
        
        if (!foundProject) {
            return { tables: [], schemas: [], project: null };
        }

        const project = foundProject as unknown as Record<string, unknown>;
        const dbName = String(project.db_name || `supa_${project.ref || 'default'}`);
        
        // Fetch All Schemas
        const schemasResult = await db.executeQuery(dbName, `
            SELECT schema_name 
            FROM information_schema.schemata 
            WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
            ORDER BY schema_name;
        `);

        // Fetch All Tables
        const tablesResult = await db.executeQuery(dbName, `
            SELECT table_schema, table_name, table_type
            FROM information_schema.tables 
            WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
            ORDER BY table_schema, table_name;
        `);

        return {
            project,
            schemas: schemasResult.rows.map((r) => (r as Record<string, unknown>).schema_name as string),
            tables: tablesResult.rows.map((r) => {
                const row = r as Record<string, unknown>;
                return { schema: row.table_schema as string, name: row.table_name as string, type: row.table_type as string };
            })
        };
    } catch (err: unknown) {
        console.error('Failed to load table metadata:', err);
        return { tables: [], schemas: [] };
    }
};
