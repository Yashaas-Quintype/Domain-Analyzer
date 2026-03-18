import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';

const BulkAnalyzer = () => {
    const [domains, setDomains] = useState('');
    const [results, setResults] = useState({});
    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0 });
    const [copying, setCopying] = useState(false);

    const abortControllerRef = useRef(null);

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            setProcessing(false);
        }
    };

    const analyzeDomain = async (domain, signal) => {
        try {
            // 1. Scraping (Entity Name & Parent)
            const scrapeRes = await axios.get(`/api/scrape?domain=${domain}`, { signal });
            const scrapeData = scrapeRes.data || {};

            // 2. Traffic
            const trafficRes = await axios.get(`/api/zyla/v2/company-traffic-data?domain=${domain}`, { signal });
            const trafficData = trafficRes.data?.data?.[0] || {};

            // 3. Tech Stack
            const techRes = await axios.get(`/api/builtwith/free/v1/api.json?domain=${domain}`, { signal });
            const techData = techRes.data || {};

            // 4. PageSpeed (Desktop then Mobile)
            const psiDesk = await axios.get(`/api/pagespeed?domain=${domain}&strategy=desktop`, { signal });
            const psiMob = await axios.get(`/api/pagespeed?domain=${domain}&strategy=mobile`, { signal });

            return {
                name: scrapeData.name || 'Unknown',
                parent: scrapeData.parentWebsite || '-',
                visits: trafficData.visits || '0',
                techCount: (techData.Paths?.[0]?.Technologies?.length) || 0,
                cms: techData.Paths?.[0]?.Technologies?.find(t => t.Tag === 'cms')?.Name || 'Custom/None',
                cdn: techData.Paths?.[0]?.Technologies?.find(t => t.Tag === 'cdn')?.Name || 'None',
                psiDesktop: Math.round((psiDesk.data?.data?.lighthouseResult?.categories?.performance?.score || 0) * 100),
                psiMobile: Math.round((psiMob.data?.data?.lighthouseResult?.categories?.performance?.score || 0) * 100)
            };
        } catch (err) {
            console.error(`Error analyzing ${domain}:`, err);
            return { name: 'Error', parent: '-', visits: '-', techCount: '-', cms: '-', cdn: '-', psiDesktop: '-', psiMobile: '-' };
        }
    };

    const startAnalysis = async () => {
        const domainList = domains.split(/[\n,]/).map(d => d.trim()).filter(d => d);
        if (domainList.length === 0) return;

        setProcessing(true);
        setResults({});
        setProgress({ current: 0, total: domainList.length });
        abortControllerRef.current = new AbortController();

        for (let i = 0; i < domainList.length; i++) {
            if (abortControllerRef.current.signal.aborted) break;
            const domain = domainList[i];
            const data = await analyzeDomain(domain, abortControllerRef.current.signal);
            setResults(prev => ({ ...prev, [domain]: data }));
            setProgress(prev => ({ ...prev, current: i + 1 }));
        }

        setProcessing(false);
    };

    const downloadCSV = () => {
        const headers = ['Domain', 'Entity Name', 'Parent Company', 'Monthly Visits', 'Technologies', 'CMS', 'CDN', 'PSI Desktop', 'PSI Mobile'];
        const csvRows = [headers.join(',')];

        Object.entries(results).forEach(([domain, data]) => {
            const row = [
                domain,
                `"${data.name}"`,
                data.parent,
                data.visits,
                data.techCount,
                data.cms,
                data.cdn,
                data.psiDesktop,
                data.psiMobile
            ];
            csvRows.push(row.join(','));
        });

        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bulk_analysis_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
    };

    const copyToClipboard = async () => {
        setCopying(true);
        const headers = ['Domain', 'Entity Name', 'Parent Company', 'Monthly Visits', 'Technologies', 'CMS', 'CDN', 'PSI Desktop', 'PSI Mobile'];
        
        // TSV format (Tab Separated Values) is the best for Google Sheets pasting
        let tsvString = headers.join('\t') + '\n';

        Object.entries(results).forEach(([domain, data]) => {
            const row = [
                domain,
                data.name,
                data.parent,
                data.visits,
                data.techCount,
                data.cms,
                data.cdn,
                data.psiDesktop,
                data.psiMobile
            ];
            tsvString += row.join('\t') + '\n';
        });

        try {
            await navigator.clipboard.writeText(tsvString);
            alert('✓ Copied to clipboard! You can now paste (Ctrl+V) into Google Sheets.');
        } catch (err) {
            console.error('Failed to copy!', err);
            alert('Failed to copy to clipboard.');
        } finally {
            setCopying(false);
        }
    };

    return (
        <div className="bg-slate-800/50 backdrop-blur-md p-8 rounded-3xl border border-slate-700/50 shadow-2xl">
            <h2 className="text-3xl font-bold text-white mb-2 flex items-center gap-3">
                <span className="p-2 bg-indigo-500/20 rounded-lg">📊</span>
                Bulk Domain Analyzer
            </h2>
            <p className="text-slate-400 mb-6">Enter domains separated by newline or comma to perform deep analysis in bulk.</p>

            <textarea
                className="w-full h-40 bg-slate-900/50 border border-slate-700 rounded-2xl p-4 text-white font-mono text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all outline-none mb-6"
                placeholder="example1.com&#10;example2.com, example3.com"
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                disabled={processing}
            />

            <div className="flex flex-wrap gap-4 mb-8">
                <button
                    onClick={processing ? handleStop : startAnalysis}
                    className={`px-8 py-3 rounded-xl font-bold transition-all transform hover:scale-105 active:scale-95 flex items-center gap-2 ${
                        processing ? 'bg-red-500/10 text-red-500 border border-red-500/50 hover:bg-red-500/20' : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/20'
                    }`}
                >
                    {processing ? (
                        <>
                            <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
                            Stop Analysis
                        </>
                    ) : (
                        <>🚀 Start Analysis</>
                    )}
                </button>

                {Object.keys(results).length > 0 && !processing && (
                    <div className="flex gap-2">
                        <button
                            onClick={downloadCSV}
                            className="px-6 py-3 bg-emerald-600/10 text-emerald-500 border border-emerald-500/50 rounded-xl font-bold hover:bg-emerald-600/20 transition-all flex items-center gap-2"
                        >
                            📥 Export CSV
                        </button>
                        <button
                            onClick={copyToClipboard}
                            className="px-6 py-3 bg-blue-600/10 text-blue-500 border border-blue-500/50 rounded-xl font-bold hover:bg-blue-600/20 transition-all flex items-center gap-2"
                        >
                            {copying ? '⌛ Copying...' : '📋 Copy to Sheets'}
                        </button>
                    </div>
                )}
            </div>

            {processing && (
                <div className="mb-8 p-4 bg-indigo-500/10 rounded-2xl border border-indigo-500/20">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-indigo-300 text-sm font-bold">Progress</span>
                        <span className="text-indigo-300 text-sm">{progress.current} / {progress.total}</span>
                    </div>
                    <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${(progress.current / progress.total) * 100}%` }}
                        />
                    </div>
                </div>
            )}

            {Object.keys(results).length > 0 && (
                <div className="overflow-x-auto rounded-2xl border border-slate-700/50 bg-slate-900/30">
                    <table className="w-full text-left border-collapse min-w-[1000px]">
                        <thead>
                            <tr className="bg-slate-800/80">
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">Domain</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">Entity</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">Parent</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50 text-right">Visits</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50 text-center">Tech</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">CMS</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50">CDN</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50 text-center">Desk</th>
                                <th className="p-4 text-xs font-bold text-slate-400 uppercase tracking-wider border-b border-slate-700/50 text-center">Mob</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700/50">
                            {Object.entries(results).map(([domain, data]) => (
                                <tr key={domain} className="hover:bg-slate-800/30 transition-colors group">
                                    <td className="p-4 text-sm font-medium text-slate-300 font-mono">{domain}</td>
                                    <td className="p-4 text-sm text-white font-bold max-w-[150px] truncate" title={data.name}>{data.name}</td>
                                    <td className="p-4 text-sm text-slate-400 max-w-[150px] truncate" title={data.parent}>{data.parent}</td>
                                    <td className="p-4 text-sm text-slate-300 text-right font-mono">{Number(data.visits).toLocaleString()}</td>
                                    <td className="p-4 text-sm text-indigo-400 text-center font-bold">{data.techCount}</td>
                                    <td className="p-4 text-sm text-slate-400">{data.cms}</td>
                                    <td className="p-4 text-sm text-slate-400">{data.cdn}</td>
                                    <td className={`p-4 text-sm text-center font-bold ${data.psiDesktop > 80 ? 'text-emerald-400' : 'text-orange-400'}`}>{data.psiDesktop}%</td>
                                    <td className={`p-4 text-sm text-center font-bold ${data.psiMobile > 80 ? 'text-emerald-400' : 'text-orange-400'}`}>{data.psiMobile}%</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default BulkAnalyzer;
