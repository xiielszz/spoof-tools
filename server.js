const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({
  dest: path.join(os.tmpdir(), "audio-studio-uploads"),
  limits: { fileSize: 1024 * 1024 * 1024 }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);
    let stderr = "";
    p.stderr.on("data", d => stderr += d.toString());
    p.on("error", reject);
    p.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

function safeExt(name) {
  const ext = path.extname(name || "").toLowerCase();
  return /^[.][a-z0-9]{1,8}$/.test(ext) ? ext : ".bin";
}

function id() {
  return crypto.randomBytes(12).toString("hex");
}

app.post("/api/process", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is required." });

  const speed = Number(req.body.speed ?? 2.3);
  const gainDb = Number(req.body.gainDb ?? -4);

  if (!Number.isFinite(speed) || speed < 0.5 || speed > 4) {
    return res.status(400).json({ error: "Speed must be between 0.5x and 4x." });
  }
  if (!Number.isFinite(gainDb) || gainDb < -24 || gainDb > 12) {
    return res.status(400).json({ error: "Gain must be between -24 dB and +12 dB." });
  }

  const work = path.join(os.tmpdir(), `audio-studio-${id()}`);
  fs.mkdirSync(work, { recursive: true });

  const input = req.file.path;
  const output = path.join(work, `processed${safeExt(req.file.originalname) === ".wav" ? ".wav" : ".mp3"}`);

  try {
    // atempo preserves pitch while changing playback tempo.
    // For values > 2.0, chain multiple atempo filters.
    let remaining = speed;
    const tempos = [];
    while (remaining > 2) {
      tempos.push(2);
      remaining /= 2;
    }
    tempos.push(remaining);

    const filter = [
      ...tempos.map(v => `atempo=${v}`),
      `volume=${gainDb}dB`
    ].join(",");

    await runFFmpeg([
      "-i", input,
      "-vn",
      "-af", filter,
      "-codec:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "48000",
      output
    ]);

    res.download(output, "processed-audio.mp3", () => {
      fs.rm(work, { recursive: true, force: true }, () => {});
      fs.rm(input, { force: true }, () => {});
    });
  } catch (e) {
    fs.rm(work, { recursive: true, force: true }, () => {});
    fs.rm(input, { force: true }, () => {});
    res.status(500).json({ error: e.message || "Processing failed." });
  }
});

app.post("/api/split", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Audio file is required." });

  const chunkMinutes = Number(req.body.chunkMinutes ?? 7);
  if (!Number.isFinite(chunkMinutes) || chunkMinutes < 6 || chunkMinutes > 7) {
    return res.status(400).json({ error: "Chunk length must be between 6 and 7 minutes." });
  }

  const work = path.join(os.tmpdir(), `audio-split-${id()}`);
  fs.mkdirSync(work, { recursive: true });

  const outputPattern = path.join(work, "part-%03d.mp3");

  try {
    await runFFmpeg([
      "-i", req.file.path,
      "-vn",
      "-f", "segment",
      "-segment_time", String(Math.round(chunkMinutes * 60)),
      "-reset_timestamps", "1",
      "-codec:a", "libmp3lame",
      "-b:a", "192k",
      "-ar", "48000",
      outputPattern
    ]);

    const parts = fs.readdirSync(work)
      .filter(x => /^part-\d{3}\.mp3$/.test(x))
      .sort();

    if (!parts.length) throw new Error("No output parts were created.");

    const manifest = {
      name: path.basename(req.file.originalname),
      count: parts.length,
      parts: parts.map(x => `/api/download/${path.basename(work)}/${x}`)
    };

    // Store the work directory until the client downloads all parts.
    const token = path.basename(work);
    res.json({ token, count: parts.length, parts: manifest.parts });
    fs.rm(req.file.path, { force: true }, () => {});
  } catch (e) {
    fs.rm(work, { recursive: true, force: true }, () => {});
    fs.rm(req.file.path, { force: true }, () => {});
    res.status(500).json({ error: e.message || "Split failed." });
  }
});

app.get("/api/download/:token/:file", (req, res) => {
  if (!/^audio-split-[a-f0-9]+$/.test(req.params.token)) return res.status(400).end();
  if (!/^part-\d{3}\.mp3$/.test(req.params.file)) return res.status(400).end();

  const file = path.join(os.tmpdir(), req.params.token, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();

  res.download(file, req.params.file, () => {
    // Keep the split directory available for the remaining downloads.
  });
});

// Express 5 requires a named wildcard parameter.
app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Audio Studio listening on port ${PORT}`);
});
