import { StorageService } from '../services/storage.service';

export const storageRoutes = (app: any) =>
    app.group('/storage', (app: any) =>
        app
            .get('/status', async () => {
                return await StorageService.getStatus();
            })
            .post('/migrate', async ({ body }: any) => {
                const { s3Url, credentials } = body as { s3Url: string, credentials: { access_key: string, secret_key: string, endpoint: string } };
                if (!s3Url || !credentials) throw new Error('Missing migration parameters');
                return await StorageService.startMigration(s3Url, credentials);
            })
    );
