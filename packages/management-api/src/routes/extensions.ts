import { ExtensionService } from '../services/extension.service';

export const extensionRoutes = (app: any) =>
    app.group('/extensions', (app: any) =>
        app
            .get('/:project_ref', async ({ params }: any) => {
                return await ExtensionService.listExtensions(params.project_ref);
            })
            .post('/:project_ref/enable', async ({ params, body }: any) => {
                const { extension } = body as { extension: string };
                return await ExtensionService.enableExtension(params.project_ref, extension);
            })
            .post('/:project_ref/disable', async ({ params, body }: any) => {
                const { extension } = body as { extension: string };
                return await ExtensionService.disableExtension(params.project_ref, extension);
            })
    );
