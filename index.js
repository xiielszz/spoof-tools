const express = require('express');
const archiver = require('archiver');
const axios = require('axios');
const { Readable } = require('stream');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Endpoint single download (redirect to file stream)
app.get('/download/:id', async (req, res) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) {
        return res.status(400).send('Invalid ID');
    }

    try {
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            timeout: 30000 // 30s
        });

        // Determine extension from content-type or fallback
        const contentType = response.headers['content-type'] || '';
        let ext = 'ogg';
        if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
        else if (contentType.includes('wav')) ext = 'wav';

        res.setHeader('Content-Disposition', `attachment; filename="roblox_${id}.${ext}"`);
        res.setHeader('Content-Type', contentType);
        response.data.pipe(res);
    } catch (err) {
        console.error(`Error downloading ${id}:`, err.message);
        res.status(500).send(`Gagal download ID ${id}: ${err.message}`);
    }
});

// Endpoint bulk: menerima array ID, return ZIP
app.post('/bulk', async (req, res) => {
    const ids = req.body.ids || [];
    if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send('Kirim array ID');
    }

    // Validasi semua ID numerik
    const validIds = ids.filter(id => /^\d+$/.test(id));
    if (validIds.length === 0) {
        return res.status(400).send('Tidak ada ID valid');
    }

    // Set header ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="roblox_bulk_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Proses setiap ID
    for (let i = 0; i < validIds.length; i++) {
        const id = validIds[i];
        try {
            const url = `https://assetdelivery.roblox.com/v1/asset/?id=${id}`;
            const response = await axios({
                method: 'get',
                url: url,
                responseType: 'stream',
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 30000
            });

            const contentType = response.headers['content-type'] || '';
            let ext = 'ogg';
            if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = 'mp3';
            else if (contentType.includes('wav')) ext = 'wav';

            const fileName = `roblox_${id}.${ext}`;
            // Append stream ke archive
            archive.append(response.data, { name: fileName });
        } catch (err) {
            console.error(`Gagal ambil ID ${id}:`, err.message);
            // tetap lanjut ke ID berikutnya
            // Kita bisa tambahkan file error placeholder jika mau
            archive.append(Buffer.from(`Error: ${err.message}`), { name: `error_${id}.txt` });
        }
    }

    archive.finalize();
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
