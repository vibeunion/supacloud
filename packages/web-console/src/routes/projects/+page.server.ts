import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ fetch }) => {
    const MASTER_TOKEN = env.SUPACLOUD_MASTER_TOKEN || 'supacloud_master_token_v1';
    const API_URL = env.SUPACLOUD_API_URL || 'http://localhost:9090';

    try {
        const response = await fetch(`${API_URL}/v1/projects`, {
            headers: {
                'Authorization': `Bearer ${MASTER_TOKEN}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch projects');
        }

        const projects = await response.json();
        return { projects };
    } catch (err) {
        // Fallback for development if API is not running
        return {
            projects: [
                { name: 'Demo App', ref: 'demo-123', region: 'local', status: 'Active', created_at: new Date().toISOString() },
                { name: 'Production Store', ref: 'store-888', region: 'us-east-1', status: 'Active', created_at: new Date().toISOString() },
                { name: 'Legacy Blog', ref: 'blog-old', region: 'local', status: 'Paused', created_at: new Date().toISOString() },
            ]
        };
    }
};
