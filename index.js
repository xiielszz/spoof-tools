const express = require('express');
const cookieSession = require('cookie-session');
const axios = require('axios');
const archiver = require('archiver');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.set('trust proxy', 1);
app.use(cookieSession({
    name: 'session',
    secret: SESSION_SECRET,
    maxAge: 60 * 60 * 1000, // 1 jam
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
}));

app.use(express.json());
app.use(express.static('public'));

// === Set cookie dari user ===
app.post('/set-cookie', (req, res) => {
    const { cookie } = req.body;
    if (!cookie || !cookie.startsWith('_|WARNING:-DO-NOT-SHARE')) {
        return res.status(400).json({ error: 'Cookie tidak valid. Harus diawali _|WARNING...' });
    }
    req.session.robloxCookie = cookie;
    res.json({ success: true, message: 'Cookie tersimpan di session.' });
});

// === Cek status cookie ===
app.get('/status', (req, res) => {
    res.json({ hasCookie: !!req.session.robloxCookie });
});

// === Hapus cookie ===
app.get('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// === Download single ===
app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) return res.status(400).send('ID invalid.');

    const cookie = req.session.robloxCookie;
    if (!cookie) return res.status(401).send('Belum set cookie. Isi form di halaman utama.');

    try {
        const response = await axios({
            method: 'get',
            url: `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
            responseType: 'stream',
            headers: {
                'Cookie': `.ROBLOSECURITY=${cookie}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 45000,
            validateStatus: status => status < 500
        });

        if (response.status !== 200) {
            throw new Error(`HTTP ${response.status} — mungkin cookie expired atau asset private.`);
        }

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

// === Bulk ZIP ===
app.post('/bulk', async (req, res) => {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send('Kirim array ID.');
    }

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
                headers: {
                    'Cookie': `.ROBLOSECURITY=${cookie}`,
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
});
