import React from 'react';

const DecisionMakers = ({ results, companyInfo, scrapedCompany, requestId, loading, error, redirectingParent }) => {
    const seniorityMap = {
        1: 'Other', 2: 'Intern', 3: 'Entry', 4: 'Senior', 5: 'Manager',
        6: 'Director', 7: 'Partner', 8: 'Vice President', 9: 'C-Suite', 10: 'Founder'
    };

    // Determine effective company name
    // Priority: Scraped Name > Lusha Name > Domain
    let effectiveCompanyName = scrapedCompany?.name;
    if (!effectiveCompanyName || effectiveCompanyName === 'Unknown Company') {
        effectiveCompanyName = companyInfo?.name;
    }
    if (!effectiveCompanyName || effectiveCompanyName === 'Unknown Company') {
        effectiveCompanyName = companyInfo?.domain;
    }

    // Determine domain to show
    const displayDomain = companyInfo?.domain || scrapedCompany?.domain || '...';

    if (!loading && !results && !error && !scrapedCompany && !companyInfo) return null;

    return (
        <div className="w-full max-w-2xl mt-12 animate-slide-up animation-delay-300">
            <div className="bg-slate-800/80 backdrop-blur-md rounded-2xl border border-slate-700/50 shadow-2xl overflow-hidden p-6">
                <div className="border-b border-slate-700/50 pb-4 mb-6">
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <span className="w-2 h-8 bg-green-400 rounded-full"></span>
                        Decision Makers
                    </h2>
                    <p className="text-slate-400 text-sm mt-1">
                        Powered by Lusha Prospecting API & Web Analysis
                    </p>
                </div>

                {/* Company & Parent Info Box */}
                {(effectiveCompanyName || displayDomain) && (
                    <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700/50 mb-6 animate-fade-in relative overflow-hidden">
                        {scrapedCompany?.parentWebsite && (
                            <div className="absolute top-0 right-0">
                                <span className="text-[9px] font-black text-white bg-indigo-600 px-3 py-1 rounded-bl-lg uppercase tracking-[0.2em]">
                                    Parent Company Data
                                </span>
                            </div>
                        )}

                        <div className="space-y-2">
                            <div>
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-0.5">Company Entity</p>
                                <p className="text-white font-bold text-lg leading-tight">{effectiveCompanyName || (loading ? 'Loading...' : 'Unknown')}</p>
                            </div>

                            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-700/30">
                                <div>
                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-0.5">Domain</p>
                                    <p className="text-slate-300 text-sm font-medium">{displayDomain}</p>
                                </div>
                                {scrapedCompany?.parentWebsite && (
                                    <div>
                                        <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-0.5">Corporate Parent</p>
                                        <p className="text-indigo-300 text-sm font-bold truncate">
                                            {scrapedCompany.parentWebsite}
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {scrapedCompany?.googlePublisherId && (
                            <div className="mt-3 pt-2 border-t border-slate-700/30 flex items-center justify-between">
                                <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">AdSense Publisher ID</p>
                                <code className="text-[10px] text-cyan-400 font-mono bg-cyan-400/10 px-2 py-0.5 rounded">{scrapedCompany.googlePublisherId}</code>
                            </div>
                        )}
                    </div>
                )}

                {loading && (
                    <div className="text-center py-10 bg-slate-900/30 rounded-xl border border-dashed border-slate-700/50 mb-6">
                        <div className="relative inline-block mb-4">
                            <div className="w-12 h-12 rounded-full border-t-2 border-b-2 border-green-500 animate-spin"></div>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-6 h-6 rounded-full bg-green-500/20 animate-pulse"></div>
                            </div>
                        </div>
                        <p className="text-white font-medium">
                            {redirectingParent
                                ? `Analyzing Parent: ${redirectingParent}...`
                                : 'Finding decision makers...'}
                        </p>
                        <p className="text-slate-500 text-xs mt-1">This may take a few moments</p>
                    </div>
                )}

                {error && !loading && (
                    <div className="bg-red-500/10 border border-red-500/50 text-red-200 p-4 rounded-lg mb-6 text-center text-sm">
                        <svg className="w-8 h-8 text-red-500 mx-auto mb-2 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        {error}
                    </div>
                )}

                {!loading && (!results || results.length === 0) && !error && (
                    <div className="text-center py-10 bg-slate-900/30 rounded-xl border border-dashed border-slate-700/50">
                        <p className="text-slate-400 text-sm">No verified decision makers found for this entity.</p>
                    </div>
                )}

                {!loading && results && results.length > 0 && (
                    <div className="space-y-6">
                        {results.map((contact, index) => (
                            <div key={contact.id || index} className="bg-slate-700/30 p-4 rounded-lg border border-slate-600/30 hover:border-green-500/30 transition-colors">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <h4 className="text-lg font-bold text-white">{contact.fullName || `${contact.firstName} ${contact.lastName}`}</h4>
                                        <p className="text-green-400 font-medium">{contact.jobTitle}</p>
                                    </div>
                                    <div className="flex flex-col items-end gap-2">
                                        {contact.socialLinks && contact.socialLinks.linkedin && (
                                            <a href={contact.socialLinks.linkedin} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 text-xs flex items-center gap-1">
                                                <span>LinkedIn</span> ↗
                                            </a>
                                        )}
                                    </div>
                                </div>

                                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-300">
                                    {/* Departments - Array handling */}
                                    {(contact.departments && contact.departments.length > 0) && (
                                        <p><span className="text-slate-500">Dept:</span> {contact.departments.join(', ')}</p>
                                    )}

                                    {/* Seniority - Array handling */}
                                    {(contact.seniority && contact.seniority.length > 0) && (
                                        <p><span className="text-slate-500">Seniority:</span> {contact.seniority.map(s => typeof s === 'object' ? (s.value || s.name || s.id) : s).join(', ')}</p>
                                    )}
                                </div>

                                {/* Contact Details Section */}
                                <div className="mt-3 pt-3 border-t border-slate-600/30 space-y-1 text-sm">
                                    {contact.emailAddresses && contact.emailAddresses.length > 0 && (
                                        <div className="flex gap-2 text-slate-300">
                                            <span className="text-slate-500 w-16">Email:</span>
                                            <div className="flex flex-col">
                                                {contact.emailAddresses.map((email, i) => (
                                                    <span key={i} className="text-white select-all">{email.email} <span className="text-xs text-slate-500">({email.emailType})</span></span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {contact.phoneNumbers && contact.phoneNumbers.length > 0 && (
                                        <div className="flex gap-2 text-slate-300">
                                            <span className="text-slate-500 w-16">Phone:</span>
                                            <div className="flex flex-col">
                                                {contact.phoneNumbers.map((phone, i) => (
                                                    <span key={i} className="text-white select-all">{phone.number} <span className="text-xs text-slate-500">({phone.phoneType})</span></span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* Employment History */}
                                    {contact.employmentHistory && contact.employmentHistory.length > 0 && (
                                        <div className="mt-4 pt-3 border-t border-slate-600/30">
                                            <p className="text-slate-400 text-xs mb-2 uppercase font-semibold">Previously worked in</p>
                                            <div className="space-y-2">
                                                {contact.employmentHistory.map((job, i) => (
                                                    <div key={i} className="text-sm">
                                                        <p className="text-slate-300 font-medium">
                                                            {job.companyName || (typeof job.company === 'object' ? job.company?.name : job.company) || 'Unknown Company'}
                                                        </p>
                                                        <p className="text-slate-500 text-xs">{job.title || job.jobTitle || 'Position not specified'}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default DecisionMakers;
