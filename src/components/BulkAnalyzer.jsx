import React, { useState, useRef } from 'react';
import axios from 'axios';
import { withRetry } from '../utils/apiRetry.js';

const BulkAnalyzer = () => {
    const [input, setInput] = useState('');
    const [domains, setDomains] = useState([]);
    const [results, setResults] = useState({});
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
    const [copied, setCopied] = useState(false);
    const fileInputRef = useRef(null);

    const [expandedDomains, setExpandedDomains] = useState(new Set());

    const toggleExpand = (domain) => {
        const next = new Set(expandedDomains);
        if (next.has(domain)) next.delete(domain);
        else next.add(domain);
        setExpandedDomains(next);
    };

    const parseDomains = (text) => {
        return text
            .split(/[\n,]+/)
            .map(d => d.trim().toLowerCase())
            .filter(d => d && d.includes('.'));
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const text = event.target.result;
            const parsed = parseDomains(text);
            setInput(parsed.join('\n'));
        };
        reader.readAsText(file);
    };

    const extractTechByType = (allTechnologies) => {
        if (!allTechnologies || allTechnologies.length === 0) return { cms: 'None', cdn: 'None' };

        const cmsKeywords = ['cms', 'content management system', 'blog', 'ecommerce', 'e-commerce'];
        const cdnKeywords = ['cdn', 'content delivery network', 'hosting-cdn', 'delivery network'];

        const cms = allTechnologies
            .filter(t => {
                const cat = (t.Tag || '').toLowerCase();
                const name = (t.Name || '').toLowerCase();
                return cmsKeywords.some(k => cat.includes(k) || name.includes(k));
            })
            .map(t => t.Name.replace(/\sHosting$/i, ''));

        const cdn = allTechnologies
            .filter(t => {
                const cat = (t.Tag || '').toLowerCase();
                const name = (t.Name || '').toLowerCase();
                return cdnKeywords.some(k => cat.includes(k) || name.includes(k));
            })
            .map(t => t.Name);

        return {
            cms: [...new Set(cms)].slice(0, 2).join(', ') || 'None',
            cdn: [...new Set(cdn)].slice(0, 2).join(', ') || 'None'
        };
    };

    const processTech = (allTechnologies) => {
        if (!allTechnologies || allTechnologies.length === 0) return 'No Tech Detected';
        const sortedTechs = [...allTechnologies].sort((a, b) => (b.LastDetected || 0) - (a.LastDetected || 0));
        const uniqueTechs = [...new Set(sortedTechs.map(t => t.Name))];
        return uniqueTechs.length > 0 ? uniqueTechs.join(', ') : 'No Tech Detected';
    };

    const formatNumber = (num) => {
        if (!num) return 'N/A';
        return new Intl.NumberFormat('en-US', { notation: "compact", compactDisplay: "short" }).format(num);
    };

    const getRoot = (d) => {
        const cleaned = d.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
        const parts = cleaned.split('.');
        if (parts.length <= 2) return cleaned;
        const multiPartTlds = ['co.uk', 'org.uk', 'me.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in'];
        const lastTwo = parts.slice(-2).join('.');
        if (multiPartTlds.includes(lastTwo) && parts.length > 2) return parts.slice(-3).join('.');
        return parts.slice(-2).join('.');
    };

    const processBulk = async () => {
        const domainList = parseDomains(input);
        if (domainList.length === 0) return;

        setDomains(domainList);
        setResults({});
        setProcessing(true);
        setProgress(0);
        setExpandedDomains(new Set());

        const BATCH_SIZE = 5;
        const BATCH_DELAY = 500;

        for (let i = 0; i < domainList.length; i += BATCH_SIZE) {
            const batch = domainList.slice(i, i + BATCH_SIZE);
            const batchResults = {};

            batch.forEach(domain => {
                batchResults[domain] = { domain, visits: 'Loading...', tech: 'Loading...', status: 'processing' };
            });

            setResults(prev => ({ ...prev, ...batchResults }));

            await Promise.all(batch.map(async (domain) => {
                try {
                    const tryFetchTraffic = async (target) => {
                        const normalized = target.replace(/^www\./i, '');
                        return withRetry(() => axios.get(`/api/zyla/api/29/site+traffic+api/93/traffic+source+and+overview`, {
                            params: { domain: normalized },
                            headers: { 'Authorization': `Bearer ${import.meta.env.VITE_ZYLALABS_KEY || '10095|mmrDs2Whvlc7fD1JKYF2CasMOSaDUZxnVkqhHEzp'}` },
                            timeout: 25000
                        })).catch(e => {
                            console.warn(`Traffic fetch failed for ${target}:`, e.message);
                            return null;
                        });
                    };

                    let trafficRes = await tryFetchTraffic(domain);
                    const hasTraffic = (r) => !!(r?.data && (r.data.Engagments || r.data.EstimatedMonthlyVisits));

                    if (!hasTraffic(trafficRes) && domain.split('.').length > 2) {
                        const root = getRoot(domain);
                        const rootRes = await tryFetchTraffic(root);
                        if (hasTraffic(rootRes)) trafficRes = rootRes;
                    }

                    const fetchBW = (target) => withRetry(() => axios.get(`/api/builtwith/v22/api.json`, {
                        params: {
                            KEY: import.meta.env.VITE_BUILTWITH_KEY || 'ea894525-80c8-4320-b284-44f5eb507593',
                            LOOKUP: target
                        }
                    })).catch(() => null);

                    let techRes = await fetchBW(domain);

                    if (!techRes?.data?.Results?.[0] && domain.split('.').length > 2) {
                        const root = getRoot(domain);
                        techRes = await fetchBW(root);
                    }

                    const visitsData = trafficRes?.data?.EstimatedMonthlyVisits || {};
                    const dates = Object.keys(visitsData).sort((a, b) => new Date(b) - new Date(a));
                    const latestMonthVisits = dates.length > 0 ? visitsData[dates[0]] : null;

                    const engagements = trafficRes?.data?.Engagments || {};
                    const totalVisits = engagements.Visits ? parseInt(engagements.Visits, 10) : latestMonthVisits;
                    const ppv = engagements.PagePerVisit ? parseFloat(engagements.PagePerVisit) : 1.5;
                    const pageViews = totalVisits ? Math.round(totalVisits * ppv) : null;

                    const last3Months = dates.slice(0, 3).map(date => ({
                        date,
                        count: formatNumber(visitsData[date])
                    }));

                    const techList = techRes?.data?.Results?.[0]?.Result?.Paths?.flatMap(p => p.Technologies) ||
                        techRes?.data?.Results?.[0]?.Result?.Technologies || [];

                    const techInfo = extractTechByType(techList);

                    batchResults[domain] = {
                        domain,
                        visits: formatNumber(totalVisits),
                        pageViews: formatNumber(pageViews),
                        history: last3Months,
                        cms: techInfo.cms,
                        cdn: techInfo.cdn,
                        fullTech: processTech(techList),
                        rawTech: techList,
                        status: 'done'
                    };

                } catch (err) {
                    console.error(`Bulk processing failed for ${domain}:`, err);
                    batchResults[domain] = { domain, status: 'error', tech: 'Failed', visits: 'Failed' };
                }

                setResults(prev => ({
                    ...prev,
                    [domain]: batchResults[domain]
                }));
            }));

            const completed = Math.min(i + BATCH_SIZE, domainList.length);
            setProgress((completed / domainList.length) * 100);

            if (completed < domainList.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY));
            }
        }

        setProcessing(false);
    };

    const downloadCSV = ()
