const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { runWithConfig } = require('./uploadOfertas.js');

const app = express();
const port = process.env.PORT || 3000;

// Setup storage for uploaded files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.static('public'));
app.use(express.json());

// SSE for logs
let logQueue = [];
app.get('/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const interval = setInterval(() => {
        while (logQueue.length > 0) {
            const msg = logQueue.shift();
            res.write(`data: ${JSON.stringify({ message: msg })}\n\n`);
        }
    }, 100);

    req.on('close', () => clearInterval(interval));
});

app.post('/run-upload', upload.single('dataFile'), async (req, res) => {
    const { email, password, contacto, dryRun } = req.body;
    const dataFile = req.file;

    if (!email || !password || !dataFile) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const config = {
        email,
        password,
        contactoOverride: contacto,
        dataFilePath: dataFile.path,
        dryRun: dryRun === 'true',
        headless: true
    };

    logQueue.push('Starting process from frontend...');

    try {
        // Run in background so we can return response early or handle it with SSE
        runWithConfig(config, (msg) => {
            logQueue.push(msg);
        }).then(() => {
            logQueue.push('--- Process Complete ---');
            // Clean up file
            fs.unlinkSync(dataFile.path);
        }).catch((err) => {
            logQueue.push(`Error: ${err.stack || err.message}`);
            if (fs.existsSync(dataFile.path)) fs.unlinkSync(dataFile.path);
        });

        res.json({ status: 'started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
