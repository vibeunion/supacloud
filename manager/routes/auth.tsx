
import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { getCookie, setCookie } from "hono/cookie";
import { ADMIN_PASSWORD } from "../lib/system";
import { LoginPage } from "../components/LoginPage";
import { getLang } from "../lib/i18n";

export const authApp = new Hono();

// Login Page
authApp.get('/login', (c) => c.html(<LoginPage lang={getLang(c)} />));

// Login Action
authApp.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const username = body['username'];
    const password = body['password'];

    // Verify credentials
    if (username === 'admin' && password === ADMIN_PASSWORD) {
        // Sign token
        const token = await sign({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 }, ADMIN_PASSWORD);
        setCookie(c, 'auth_token', token, {
            httpOnly: true,
            path: '/',
            maxAge: 60 * 60 * 24,
            secure: false // Allow http for internal IPs
        });
        return c.redirect('/');
    }

    return c.html(<LoginPage error="Invalid credentials" lang={getLang(c)} />);
});

// Middleware Logic (exported function to use in main app)
export const authMiddleware = async (c: any, next: any) => {
    const path = c.req.path;
    // Allow public routes
    if (path === '/login' || path.startsWith('/static') || path === '/favicon.ico' || path === '/lang') {
        return next();
    }

    const token = getCookie(c, 'auth_token');
    if (!token) {
        return c.redirect('/login');
    }

    try {
        await verify(token, ADMIN_PASSWORD);
        return next();
    } catch (e) {
        return c.redirect('/login');
    }
};
