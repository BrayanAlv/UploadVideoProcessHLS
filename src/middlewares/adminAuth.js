// middlewares/adminAuth.js
//
// Basic Auth para el panel admin. Credenciales por default vía env
// (ADMIN_USER / ADMIN_PASSWORD, defaults admin/admin). El panel se accede solo
// por túnel al VPS, así que es una protección básica, no de alto riesgo.

import crypto from 'crypto';

const REALM = 'Panel Admin';

export function getAdminCredentials() {
    return {
        user: process.env.ADMIN_USER || 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin',
    };
}

// Comparación en tiempo constante y a prueba de longitudes distintas.
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

export function adminAuth(req, res, next) {
    const { user, password } = getAdminCredentials();

    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        const reqUser = idx >= 0 ? decoded.slice(0, idx) : decoded;
        const reqPass = idx >= 0 ? decoded.slice(idx + 1) : '';

        // Evaluamos ambos siempre para no filtrar cuál falló por timing.
        const okUser = safeEqual(reqUser, user);
        const okPass = safeEqual(reqPass, password);
        if (okUser && okPass) return next();
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    return res.status(401).json({ error: 'Credenciales requeridas' });
}

export default adminAuth;
