import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
    return json({ error: 'SQL query proxy is not available in the static console build' }, { status: 501 });
};
