import axios from 'axios';
import { scrapeLegal } from '../src/services/legalScraper.js';

export default async function handler(req, res) {
    const { service, path } = req.query;
    const method = req.method;
    const body = req.body;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, api_key, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    try {
        if (service === 'scrape') {
            const { domain } = req.query;
            if (!domain) return res.status(400).json({ error: 'Domain is required' });
            const result = await scrapeLegal(domain);
            return res.status(200).json(result);
        }

        if (service === 'pagespeed') {
            const { domain, strategy } = req.query;
            if (!domain || !strategy) return res.status(400).json({ error: 'domain and strategy are required' });

            const key = process.env.VITE_PAGESPEED_KEY;
            const fields = 'loadingExperience,originLoadingExperience,lighthouseResult.categories.performance.score,lighthouseResult.lighthouseVersion';
            const target = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${domain}/&key=${key}&category=performance&strategy=${strategy}&fields=${encodeURIComponent(fields)}`;

            const response = await axios.get(target);
            return res.status(200).json(response.data);
        }

        let targetUrl = '';
        let headers = { 'Content-Type': 'application/json' };

        if (service === 'lusha') {
            targetUrl = `https://api.lusha.com/${path}`;
            headers['api_key'] = process.env.VITE_LUSHA_API_KEY;
        } else if (service === 'zyla') {
            const cleanPath = path || '';
            targetUrl = `https://zylalabs.com/${cleanPath}`;
            headers['Authorization'] = `Bearer ${process.env.VITE_ZYLALABS_KEY}`;
        } else if (service === 'builtwith') {
            const key = process.env.VITE_BUILTWITH_KEY;
            targetUrl = `https://api.builtwith.com/${path}&KEY=${key}`;
        }

        const response = await axios({
            method,
            url: targetUrl,
            headers,
            data: body,
            params: req.query
        });

        return res.status(200).json(response.data);
    } catch (error) {
        console.error(`Proxy Error (${service}):`, error.message);
        return res.status(error.response?.status || 500).json(error.response?.data || { error: error.message });
    }
}
