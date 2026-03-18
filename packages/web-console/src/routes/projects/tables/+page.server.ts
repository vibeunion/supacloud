import type { PageServerLoad } from './$types';
import { db } from '$management/db';
import { projectService } from '$management/services';

export const load: PageServerLoad = async ({ url }) => {
    const projectRef = url.searchParams.get('ref') || 'default';
    
    try {
        const projects = await projectService.listProjects();
        const project = (projects.find(p => p.ref === projectRef) || projects[0]) as any;
        
        if (!project) {
            return { tables: [], schemas: [], project: null };
        }

        const dbName = project.db_name || `supa_${project.ref}`;
        
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
            schemas: schemasResult.rows.map((r: any) => r.schema_name),
            tables: tablesResult.rows.map((r: any) => ({
                schema: r.table_schema,
                name: r.table_name,
                type: r.table_type
            }))
        };
    } catch (err) {
        console.error('Failed to load table metadata:', err);
        return { tables: [], schemas: [] };
    }
};
