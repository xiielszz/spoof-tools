const express = require('express');
const session = require('express-session');
const axios = require('axios');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIGURATION ===
const CLIENT_ID = process.env.ROBLOX_CLIENT_ID;
const CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET;
const REDIRECT_URI = 'https://spoof-tools-production.up.railway.app/oauth/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ ERROR: ROBLOX_CLIENT_ID dan ROBLOX_CLIENT_SECRET wajib di-set di environment!');
    process.exit(1);
}

// === SESSION (buat nyimpen state & access token sementara) ===
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 600000 } // 10 menit
}));

app.use(express.json());
app.use(express.static('public'));

// === HELPER: Dapetin OIDC Config dari Roblox ===
async function getOidcConfig() {
    const response = await axios.get('https://apis.roblox.com/oauth/.well-known/openid-configuration');
    return response.data;
}

// === ROUTE 1: Login — redirect user ke Roblox ===
app.get('/auth/login', async (req, res) => {
    const config = await getOidcConfig();
    const authorizationUrl = config.authorization_endpoint; // https://apis.roblox.com/oauth/v1/authorize[reference:8]

    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid profile',
        state: state
    });

    res.redirect(`${authorizationUrl}?${params.toString()}`);
});

// === ROUTE 2: Callback — Roblox redirect balik ke sini ===
app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;

    // Validasi state biar aman dari CSRF
    if (!state || state !== req.session.oauthState) {
        return res.status(400).send('State mismatch — possible CSRF attack.');
    }

    if (!code) {
        return res.status(400).send('Authorization code not found.');
    }

    try {
        const config = await getOidcConfig();
        const tokenUrl = config.token_endpoint; // https://apis.roblox.com/oauth/v1/token

        // Tukar code → access token
        const tokenResponse = await axios.post(tokenUrl, new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
            code: code
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;

        // Simpan token di session user
        req.session.accessToken = accessToken;

        // Redirect ke halaman utama (udah login)
        res.redirect('/');
    } catch (error) {
        console.error('OAuth callback error:', error.response?.data || error.message);
        res.status(500).send(`Login gagal: ${error.response?.data?.error_description || error.message}`);
    }
});

// === ROUTE 3: Cek status login ===
app.get('/auth/status', (req, res) => {
    const isLoggedIn = !!req.session.accessToken;
    res.json({ loggedIn: isLoggedIn });
});

// === ROUTE 4: Logout ===
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// === ROUTE 5: Download single asset (pake token user) ===
app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id) || id.length < 1) {
        return res.status(400).send('ID tidak valid.');
    }

    const token = req.session.accessToken;
    if (!token) {
        return res.status(401).send('Anda belum login. Klik "Login with Roblox" dulu.');
    }

    try {
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            headers: {
                'Authorization': `Bearer ${token}`, // OAuth 2.0 authentication[reference:9]
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 45000,
            validateStatus: (status) => status < 500
        });

        if (response.status !== 200) {
            throw new Error(`Roblox return HTTP ${response.status} — mungkin asset private atau tidak ditemukan.`);
        }

        const contentType = response.headers['content-type'] || '';
        let ext = 'ogg';
        if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
        else if (contentType.includes('wav')) ext = 'wav';

        res.setHeader('Content-Disposition', `attachment; filename="roblox_${id}.${ext}"`);
        res.setHeader('Content-Type', contentType);
        response.data.pipe(res);
    } catch (error) {
        console.error(`Error downloading ${id}:`, error.message);
        res.status(500).send(`Gagal download ID ${id}: ${error.message}`);
    }
});

// === ROUTE 6: Bulk download ZIP (pake token user) ===
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
        return res.status(401).send('Anda belum login. Klik "Login with Roblox" dulu.');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="roblox_bulk_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const id of validIds) {
        try {
            const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 45000,
                validateStatus: (status) => status < 500
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
            console.error(`Gagal ambil ID ${id}:`, error.message);
            archive.append(Buffer.from(`Error: ${error.message}`), { name: `error_${id}.txt` });
        }
    }

    archive.finalize();
});

// === Start server ===
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔐 Redirect URI: ${REDIRECT_URI}`);
    console.log(`📌 Buka: http://localhost:${PORT}`);
});
