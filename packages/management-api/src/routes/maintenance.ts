import { MaintenanceService } from '../services/maintenance.service';

export const maintenanceRoutes = (app: any) =>
    app.group('/maintenance', (app: any) =>
        app
            .post('/switchover', async ({ body }: any) => {
                const { cluster, candidate } = body as { cluster?: string; candidate?: string };
                return await MaintenanceService.switchover(cluster, candidate);
            })
            .post('/reload', async ({ body }: any) => {
                const { ip } = body as { ip: string };
                if (!ip) throw new Error('Node IP is required');
                return await MaintenanceService.reloadConfig(ip);
            })
            .post('/replicas', async ({ body }: any) => {
                const { ip } = body as { ip: string };
                if (!ip) throw new Error('Replica IP is required');
                return await MaintenanceService.addReplica(ip);
            })
    );
