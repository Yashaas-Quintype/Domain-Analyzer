import https from 'https';

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api_key, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const LUSHA_API_KEY = process.env.VITE_LUSHA_API_KEY || '34aa0ade-c0d6-4e22-b391-dc281d12d2e1';

    // Extract the path after /api/lusha
    // If calling /api/lusha/prospecting/contact/search, the req.url might be /api/lusha/prospecting/contact/search
    // We want to forward everything after /api/lusha to api.lusha.com
    const path = req.url.replace(/^\/api\/lusha/, '');
    const url = `https://api.lusha.com${path}`;

    const options = {
        method: req.method,
        headers: {
            'api_key': LUSHA_API_KEY,
            'Content-Type': 'application/json'
        }
    };

    return new Promise((resolve, reject) => {
        const proxyReq = https.request(url, options, (proxyRes) => {
            let body = '';
            proxyRes.on('data', (chunk) => body += chunk);
            proxyRes.on('end', () => {
                res.status(proxyRes.statusCode).send(body);
                resolve();
            });
        });

        proxyReq.on('error', (err) => {
            res.status(500).json({ error: err.message });
            resolve();
        });

        if (req.method === 'POST') {
            // Forward the body
            proxyReq.write(JSON.stringify(req.body));
        }
        proxyReq.end();
    });
}
