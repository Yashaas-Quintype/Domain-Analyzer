import { scrapeLegal } from '../src/services/legalScraper.js';

export default async function handler(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { domain } = req.query;

    if (!domain) {
        return res.status(400).json({ error: 'Domain is required' });
    }

    console.log(`Received scraping request for: ${domain}`);

    try {
        const result = await scrapeLegal(domain);
        if (result) {
            result.domain = domain;
            return res.json(result);
        } else {
            return res.json(null);
        }
    } catch (error) {
        console.error(`Error scraping ${domain}:`, error);
        return res.status(500).json({ error: 'Failed to scrape domain' });
    }
}
