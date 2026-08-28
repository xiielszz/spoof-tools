const express = require('express');
const cookieSession = require('cookie-session');
const axios = require('axios');
const archiver = require('archiver');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === PERCAYA PROXY (Railway pake load balancer) ===
app.set('trust proxy', 1);

const CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const REDIRECT_URI = 'https://spoof-tools-production.up.railway.app/oauth/callback';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ ERROR: ROBLOX_CLIENT_ID dan ROBLOX_CLIENT_SECRET wajib di-set!');
    process.exit(1);
}

if (!process.env.SESSION_SECRET) {
    console.warn('⚠️ SESSION_SECRET tidak di-set, pake random (akan error kalo server restart)');
}

// === SESSION PAKE COOKIE dengan SECRET STATIS ===
app.use(cookieSession({
    name: 'session',
    secret: SESSION_SECRET, // <- SEKARANG STATIS
    maxAge: 10 * 60 * 1000, // 10 menit
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
}));

app.use(express.json());
app.use(express.static('public'));

async function getOidcConfig() {
    const response = await axios.get('https://apis.roblox.com/oauth/.well-known/openid-configuration');
    return response.data;
}

// === ROUTE 1: Login ===
app.get('/auth/login', async (req, res) => {
    const config = await getOidcConfig();
    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;
    console.log(`[LOGIN] State generated: ${state}`); // buat debugging

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid profile',
        state: state
    });

    res.redirect(`${config.authorization_endpoint}?${params.toString()}`);
});

// === ROUTE 2: Callback ===
app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    const sessionState = req.session.oauthState;

    console.log(`[CALLBACK] State from query: ${state}`);
    console.log(`[CALLBACK] State from session: ${sessionState}`);

    if (!state || !sessionState || state !== sessionState) {
        // Redirect balik ke login otomatis biar user gak bingung
        return res.redirect('/auth/login?error=session_expired');
    }

    if (!code) {
        return res.status(400).send('Authorization code not found.');
    }

    try {
        const config = await getOidcConfig();
        const tokenResponse = await axios.post(config.token_endpoint, new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
            code: code
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        req.session.accessToken = tokenResponse.data.access_token;
        req.session.oauthState = null; // bersihin state setelah dipake
        res.redirect('/');
    } catch (error) {
        console.error('OAuth error:', error.response?.data || error.message);
        res.status(500).send(`Login gagal: ${error.response?.data?.error_description || error.message}`);
    }
});

// === ROUTE 3: Status ===
app.get('/auth/status', (req, res) => {
    res.json({ loggedIn: !!req.session.accessToken });
});

// === ROUTE 4: Logout ===
app.get('/auth/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// === ROUTE 5: Download single ===
app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) {
        return res.status(400).send('ID tidak valid.');
    }

    const token = req.session.accessToken;
    if (!token) {
        return res.status(401).send('Login dulu.');
    }

    try {
        const response = await axios({
            method: 'get',
            url: `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
            responseType: 'stream',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 45000,
            validateStatus: status => status < 500
        });

        if (response.status !== 200) {
            throw new Error(`Roblox return HTTP ${response.status}`);
        }

        const contentType = response.headers['content-type'] || '';
        let ext = 'ogg';
        if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
        else if (contentType.includes('wav')) ext = 'wav';

        res.setHeader('Content-Disposition', `attachment; filename="roblox_${id}.${ext}"`);
        res.setHeader('Content-Type', contentType);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send(`Gagal download: ${error.message}`);
    }
});

// === ROUTE 6: Bulk ZIP ===
app.post('/bulk', async (req, res) => {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send('Kirim array ID.');
    }

    const validIds = ids.filter(id => /^\d+$/.test(id));
    if (validIds.length === 0) {
        return res.status(400).send('Tidak ada ID valid.');
    }

    const token = req.session.accessToken;
    if (!token) {
        return res.status(401).send('Login dulu.');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="roblox_bulk_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const id of validIds) {
        try {
            const response = await axios({
                method: 'get',
                url: `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
                responseType: 'stream',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 45000,
                validateStatus: status => status < 500
            });

            if (response.status !== 200) {
                throw new Error(`HTTP ${response.status}`);
            }

            const contentType = response.headers['content-type'] || '';
            let ext = 'ogg';
            if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
            else if (contentType.includes('wav')) ext = 'wav';

            archive.append(response.data, { name: `roblox_${id}.${ext}` });
        } catch (error) {
            archive.append(Buffer.from(`Error: ${error.message}`), { name: `error_${id}.txt` });
        }
    }

    archive.finalize();
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Redirect URI: ${REDIRECT_URI}`);
    console.log(`🔑 Session secret: ${SESSION_SECRET ? 'SET' : 'RANDOM (TIDAK AMAN)'}`);
});
