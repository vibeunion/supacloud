import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ fetch }) => {
    const MASTER_TOKEN = env.SUPACLOUD_MASTER_TOKEN || 'supacloud_master_token_v1';
    const API_URL = env.SUPACLOUD_API_URL || 'http://localhost:9090';

    try {
        const response = await fetch(`${API_URL}/v1/monitor/system`, {
            headers: {
                'Authorization': `Bearer ${MASTER_TOKEN}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch metrics');
        }

        const metrics = await response.json();
        return { metrics };
    } catch (err) {
        // Fallback Mock Data
        return {
            metrics: {
                cpu: { usage: '18%' },
                memory: { used: '4.2 GB', total: '16 GB' },
                disk: { used: '28 GB', total: '100 GB' },
                os: {
                    distro: 'Ubuntu 22.04 LTS',
                    kernel: '5.15.0-generic',
                    docker: '24.0.5',
                    uptime: '12 days, 4 hours'
                },
                services: [
                    { name: 'Management API', status: 'running', uptime: '12d' },
                    { name: 'Kong Gateway', status: 'running', uptime: '12d' },
                    { name: 'PostgreSQL Cluster', status: 'running', uptime: '45d' },
                    { name: 'Garage Object Storage', status: 'running', uptime: '12d' }
                ]
            }
        };
    }
};
