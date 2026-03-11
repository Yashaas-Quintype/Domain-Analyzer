import React, { useState, useRef } from 'react';
import axios from 'axios';
import { withRetry } from '../utils/apiRetry.js';

const BulkAnalyzer = () => {
    const [input, setInput] = useState('');
    const [domains, setDomains] = useState([]);
    const [results, setResults] = useState({});
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState(0);
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

    const processBulk = async () => {
        const domainList = parseDomains(input);
        if (domainList.length === 0) return;

        setDomains(domainList);
        setResults({});
        setProcessing(true);
        setProgress(0);
        setExpandedDomains(new Set());

        const BATCH_SIZE = 5;
        const BATCH_DELAY = 500; // 0.5s between batches

        for (let i = 0; i < domainList.length; i += BATCH_SIZE) {
            const batch = domainList.slice(i, i + BATCH_SIZE);
            const batchResults = {};

            // Initialize status for this batch locally
            batch.forEach(domain => {
                batchResults[domain] = { domain, visits: 'Loading...', tech: 'Loading...', status: 'processing' };
            });

            // Single update for initial batch status
            setResults(prev => ({ ...prev, ...batchResults }));

            await Promise.all(batch.map(async (domain) => {
                try {
                    const tryFetchTraffic = async (target) => {
                        const normalized = target.replace(/^www\\./i, '');
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

                    const getRoot = (d) => {
                        const cleaned = d.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
                        const parts = cleaned.split('.');
                        if (parts.length <= 2) return cleaned;
                        const multiPartTlds = ['co.uk', 'org.uk', 'me.uk', 'net.uk', 'com.au', 'net.au', 'org.au', 'co.in', 'net.in', 'org.in'];
                        const lastTwo = parts.slice(-2).join('.');
                        if (multiPartTlds.includes(lastTwo) && parts.length > 2) return parts.slice(-3).join('.');
                        return parts.slice(-2).join('.');
                    };

                    // Root fallback for traffic
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

                    // Root fallback for BuiltWith in bulk mode
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

                    // Update local batch results
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

                // Partially update state as each domain finishes for visual feedback
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

    const downloadCSV = () => {
        const escapeCSV = (str) => {
            if (str === null || str === undefined) return '""';
            const escaped = String(str).replace(/"/g, '""');
            return `"${escaped}"`;
        };

        // Get all unique months across all results for headers
        const allMonths = new Set();
        domains.forEach(d => {
            if (results[d]?.history) {
                results[d].history.forEach(h => allMonths.add(h.date));
            }
        });
        const sortedMonths = Array.from(allMonths).sort().reverse().slice(0, 3);

        const headers = [
            'Domain',
            ...sortedMonths.map(m => `Visits (${m})`),
            'Latest Page Views',
            'CMS',
            'CDN'
        ];

        const csvRows = [
            headers.join(','),
            ...domains.map(d => {
                const res = results[d] || {};

                // Extract separate CMS and CDN for the row
                const rawTech = res.rawTech || []; // Need to make sure rawTech is stored
                const cmsList = rawTech.filter(t => (t.Tag || '').toLowerCase().includes('cms')).map(t => t.Name);
                const cdnList = rawTech.filter(t => {
                    const cat = (t.Tag || '').toLowerCase();
                    const name = (t.Name || '').toLowerCase();
                    return cat.includes('cdn') || name.includes('content delivery network');
                }).map(t => t.Name);

                // Map monthly visits
                const monthViews = sortedMonths.map(month => {
                    const match = res.history?.find(h => h.date === month);
                    return match ? match.count : 'N/A';
                });

                return [
                    escapeCSV(d),
                    ...monthViews.map(v => escapeCSV(v)),
                    escapeCSV(res.pageViews || 'N/A'),
                    escapeCSV([...new Set(cmsList)].slice(0, 2).join(', ')),
                    escapeCSV([...new Set(cdnList)].slice(0, 2).join(', '))
                ].join(',');
            })
        ];

        const csvString = csvRows.join('\n');
        const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `bulk_analysis_${new Date().toISOString().slice(0, 10)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="w-full animate-slide-up">
            <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden p-6">
                <div className="mb-6">
                    <h2 className="text-xl font-bold text-white mb-2 flex items-center gap-2">
                        <span className="w-2 h-6 bg-cyan-400 rounded-full"></span>
                        Bulk Domain Analysis
                    </h2>
                    <p className="text-slate-400 text-sm">Enter multiple domains or upload a CSV file.</p>
                </div>

                <div className="grid gap-4 mb-6">
                    <textarea
                        className="w-full bg-slate-900/50 border border-slate-700 rounded-lg p-4 text-white placeholder-slate-500 min-h-[150px] focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
                        placeholder="example.com&#10;google.com&#10;apple.com"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={processing}
                    />

                    {parseDomains(input).length > 50 && (
                        <div className="bg-amber-500/10 border border-amber-500/50 text-amber-200 p-3 rounded-lg text-xs flex items-center gap-2 animate-fade-in">
                            <svg className="w-5 h-5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span>
                                <strong>Large Dataset Detected:</strong> Processing {parseDomains(input).length} domains will take approximately {Math.ceil(parseDomains(input).length * 1.5 / 60 / 3)} minutes due to API rate limits.
                            </span>
                        </div>
                    )}

                    <div className="flex flex-wrap gap-3">
                        <button
                            onClick={() => fileInputRef.current.click()}
                            disabled={processing}
                            className="flex-1 min-w-[150px] bg-slate-700 hover:bg-slate-600 text-slate-200 py-3 rounded-lg font-semibold transition-all border border-slate-600 flex items-center justify-center gap-2"
                        >
                            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                            </svg>
                            Upload CSV
                        </button>
                        <input
                            type="file"
                            className="hidden"
                            ref={fileInputRef}
                            accept=".csv,.txt"
                            onChange={handleFileUpload}
                        />

                        <button
                            onClick={processBulk}
                            disabled={processing || !input.trim()}
                            className="flex-[2] min-w-[200px] bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white py-3 rounded-lg font-bold transition-all shadow-lg shadow-indigo-500/20"
                        >
                            {processing ? `Processing... ${Math.round(progress)}%` : 'Run Analysis'}
                        </button>
                    </div>
                </div>

                {processing && (
                    <div className="w-full bg-slate-900 rounded-full h-2.5 mb-6 overflow-hidden border border-slate-700">
                        <div
                            className="bg-gradient-to-r from-indigo-500 to-cyan-400 h-2.5 rounded-full transition-all duration-500 ease-out"
                            style={{ width: `${progress}%` }}
                        ></div>
                    </div>
                )}

                {domains.length > 0 && (
                    <div className="mt-8">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-bold text-white">Results ({domains.length})</h3>
                            <button
                                onClick={downloadCSV}
                                className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 transition-colors flex items-center gap-1 bg-cyan-400/10 px-3 py-1.5 rounded-md border border-cyan-400/20"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Export CSV
                            </button>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-slate-700/50">
                            <table className="w-full text-left text-sm border-collapse">
                                <thead className="bg-slate-900/50 text-slate-400 uppercase tracking-wider text-[10px]">
                                    <tr>
                                        <th className="px-4 py-3 font-semibold">Domain</th>
                                        <th className="px-4 py-3 font-semibold text-center">3-Month Traffic</th>
                                        <th className="px-4 py-3 font-semibold">CMS</th>
                                        <th className="px-4 py-3 font-semibold">CDN</th>
                                        <th className="px-4 py-3 font-semibold text-center">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-700/50">
                                    {domains.map((d) => (
                                        <React.Fragment key={d}>
                                            <tr className="hover:bg-slate-700/30 transition-colors group">
                                                <td className="px-4 py-4">
                                                    <div className="text-slate-200 font-medium">{d}</div>
                                                    {results[d]?.status === 'processing' && (
                                                        <div className="flex items-center gap-1.5 mt-1">
                                                            <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse"></span>
                                                            <span className="text-[10px] text-slate-500 font-mono italic">Scanning...</span>
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-4 py-4 text-center">
                                                    {results[d]?.status === 'done' ? (
                                                        <div className="flex flex-col gap-1 items-center">
                                                            <div className="flex gap-1">
                                                                {results[d].history && results[d].history.length > 0 ? (
                                                                    results[d].history.map((h, idx) => (
                                                                        <div key={idx} className="bg-slate-900/50 px-1.5 py-0.5 rounded border border-slate-700/50 text-[10px]">
                                                                            <span className="text-slate-500 mr-1">{h.date.split('-')[1]}:</span>
                                                                            <span className="text-cyan-400 font-bold">{h.count}</span>
                                                                        </div>
                                                                    ))
                                                                ) : (
                                                                    <span className="text-[10px] text-slate-500 italic">No historical data</span>
                                                                )}
                                                            </div>
                                                            <div className="text-[10px] text-slate-500 font-mono">PV: {results[d].pageViews || 'N/A'}</div>
                                                        </div>
                                                    ) : results[d]?.status === 'error' ? (
                                                        <span className="text-red-400 text-xs font-semibold">Failed</span>
                                                    ) : '-'}
                                                </td>
                                                <td className="px-4 py-4 text-slate-300">
                                                    <div className="max-w-[120px] truncate" title={results[d]?.cms}>
                                                        {results[d]?.status === 'done' ? (results[d]?.cms || 'None') : results[d]?.status === 'error' ? <span className="text-red-900/50 opacity-50">Error</span> : '-'}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-4 text-slate-300">
                                                    <div className="max-w-[120px] truncate" title={results[d]?.cdn}>
                                                        {results[d]?.status === 'done' ? (results[d]?.cdn || 'None') : results[d]?.status === 'error' ? <span className="text-red-900/50 opacity-50">Error</span> : '-'}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-4 text-center">
                                                    <button
                                                        onClick={() => toggleExpand(d)}
                                                        disabled={results[d]?.status !== 'done'}
                                                        className={`bg-slate-900/50 hover:bg-indigo-500/20 text-indigo-400 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-indigo-500/50 transition-all disabled:opacity-30 disabled:pointer-events-none flex items-center gap-1 mx-auto text-[10px] font-bold uppercase tracking-wider`}
                                                    >
                                                        {expandedDomains.has(d) ? 'Close' : 'View More'}
                                                        <svg className={`w-3.5 h-3.5 transition-transform duration-300 ${expandedDomains.has(d) ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                                                        </svg>
                                                    </button>
                                                </td>
                                            </tr>
                                            {expandedDomains.has(d) && results[d]?.status === 'done' && (
                                                <tr className="bg-slate-900/40 animate-fade-in border-l-2 border-indigo-500">
                                                    <td colSpan="5" className="px-6 py-4">
                                                        <div className="grid md:grid-cols-2 gap-6">
                                                            <div>
                                                                <h4 className="text-xs font-bold text-slate-500 uppercase mb-3 flex items-center gap-2">
                                                                    <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                                                                    </svg>
                                                                    3-Month Traffic History
                                                                </h4>
                                                                <div className="flex gap-4">
                                                                    {results[d].history?.map(h => (
                                                                        <div key={h.date} className="bg-slate-800/50 p-3 rounded-lg border border-slate-700/50 flex-1">
                                                                            <div className="text-[10px] text-slate-500 mb-1">{h.date}</div>
                                                                            <div className="text-sm font-bold text-white">{h.count}</div>
                                                                        </div>
                                                                    ))}
                                                                    <div className="bg-indigo-500/10 p-3 rounded-lg border border-indigo-500/30 flex-1">
                                                                        <div className="text-[10px] text-indigo-400 mb-1 uppercase font-black">Est. Page Views</div>
                                                                        <div className="text-sm font-bold text-indigo-300">{results[d].pageViews || 'N/A'}</div>
                                                                    </div>
                                                                    {(!results[d].history || results[d].history.length === 0) && (
                                                                        <div className="text-slate-600 italic text-xs">No historical data available</div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            <div>
                                                                <h4 className="text-xs font-bold text-slate-500 uppercase mb-3 flex items-center gap-2">
                                                                    <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                                                                    </svg>
                                                                    Full Technology Stack
                                                                </h4>
                                                                <div className="text-xs text-slate-300 leading-relaxed bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
                                                                    {results[d].fullTech}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default BulkAnalyzer;
