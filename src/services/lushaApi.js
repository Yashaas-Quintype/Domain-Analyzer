import axios from 'axios';
import { withRetry } from '../utils/apiRetry.js';

const LUSHA_API_KEY = (import.meta.env?.VITE_LUSHA_API_KEY) || '34aa0ade-c0d6-4e22-b391-dc281d12d2e1';

const cleanDomainForSearch = (domain) => {
    if (!domain) return '';
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    // Remove common legal suffixes and the user's mentioned typo 'limted'
    // This allows us to find variants like 'breakingmedialimited.com' => 'breakingmedia.com'
    const variant = cleaned.replace(/(limited|ltd|inc|corp|corporation|llc|plc|gmbh|limted)(\.[a-z]{2,}(\.[a-z]{2})?)$/i, '$2');

    return variant;
};

const cleanDomainForMatch = (domain) => {
    if (!domain) return { full: '', base: '' };
    let cleaned = domain.toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/(.*)$/, '')
        .trim();

    // Remove common suffixes like .com, .net, .in etc to get the 'base'
    const baseName = cleaned.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '');

    return { full: cleaned, base: baseName };
};

export const searchDecisionMakers = async (domain, { onRetry = null, isParent = false, companyName = null } = {}) => {
    if (!LUSHA_API_KEY) {
        throw new Error("API Key is missing. Please check your .env file.");
    }

    const performSearch = async (targetDomain) => {
        if (!targetDomain) return { searchContacts: [], requestId: null };
        try {
            console.log(`Step 1: Searching decision makers for domain: ${targetDomain}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: {
                            include: {
                                // Search by seniority only — no department filter.
                                // Many companies (especially regional/smaller ones) have no
                                // department tags in Lusha. We apply role filtering post-enrichment.
                                seniority: [10, 9, 8, 7, 6]
                            }
                        },
                        companies: { include: { domains: [targetDomain] } }
                    }
                },
                {
                    params: { page_size: 100 },
                    headers: { 'api_key': LUSHA_API_KEY, 'Content-Type': 'application/json' }
                }
            ), {
                initialDelay: 2000,
                onRetry: (count, delay) => onRetry?.(`Lusha Search (${count}/5)`, delay)
            });

            return {
                searchContacts: searchResponse.data.data || searchResponse.data.contacts || [],
                requestId: searchResponse.data.requestId
            };
        } catch (err) {
            console.warn(`Search failed for ${targetDomain}:`, err.message);
            return { searchContacts: [], requestId: null };
        }
    };

    const performNameSearch = async (name) => {
        if (!name || name.length < 3) return { searchContacts: [], requestId: null };
        try {
            console.log(`Step 1B: Searching decision makers by Name: ${name}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: {
                            include: {
                                seniority: [10, 9, 8, 7, 6]
                            }
                        },
                        companies: { include: { name: [name] } }
                    }
                },
                {
                    params: { page_size: 100 },
                    headers: { 'api_key': LUSHA_API_KEY, 'Content-Type': 'application/json' }
                }
            ), {
                initialDelay: 2000,
                onRetry: (count, delay) => onRetry?.(`Lusha Name Search (${count}/5)`, delay)
            });

            return {
                searchContacts: searchResponse.data.data || searchResponse.data.contacts || [],
                requestId: searchResponse.data.requestId
            };
        } catch (err) {
            console.warn(`Name search failed for ${name}:`, err.message);
            return { searchContacts: [], requestId: null };
        }
    };

    try {
        let { searchContacts, requestId } = await performSearch(domain);

        // Fallback 1: Root domain if subdomain search yielded nothing
        if (searchContacts.length === 0 && domain && domain.split('.').length > 2) {
            const root = domain.split('.').slice(-2).join('.');
            console.log(`No contacts for ${domain}, checking root: ${root}`);
            const rootResult = await performSearch(root);
            searchContacts = rootResult.searchContacts;
            requestId = rootResult.requestId || requestId;
        }

        // Fallback 2: Cleaned domain variant (removes 'limited', etc.)
        const variant = cleanDomainForSearch(domain);
        const currentDomainOnly = domain ? domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '') : '';

        if (variant && variant !== currentDomainOnly && variant.includes('.')) {
            // Aggressive: Merging variants if we have few contacts or it's a parent search
            if (isParent || searchContacts.length < 25) {
                console.log(`Checking cleaned domain variant: ${variant}`);
                const variantResult = await performSearch(variant);

                if (variantResult.searchContacts.length > 0) {
                    const existingIds = new Set(searchContacts.map(c => c.contactId || c.id || c.personId));
                    const newContacts = variantResult.searchContacts.filter(c => !existingIds.has(c.contactId || c.id || c.personId));
                    console.log(`Adding ${newContacts.length} contacts from variant: ${variant}`);
                    searchContacts = [...searchContacts, ...newContacts];
                    requestId = requestId || variantResult.requestId;
                }
            }
        }

        // Fallback 3: Search by Company Name if still no results
        if (searchContacts.length === 0 && companyName) {
            const nameResult = await performNameSearch(companyName);
            searchContacts = nameResult.searchContacts;
            requestId = nameResult.requestId || requestId;
        }

        if (searchContacts.length === 0) {
            return {
                contacts: [],
                requestId,
                companyInfo: { name: companyName || 'Unknown Company', domain: domain }
            };
        }

        // STEP 2: Enrich contacts
        // Only hard-exclude clearly irrelevant roles (HR, Marketing ops, pure Sales).
        // Keep Finance leadership (CFO, etc.) and anything without dept data.
        const EXCLUDED_DEPARTMENTS = [
            'human resources', 'hr', 'people operations', 'talent acquisition',
            'recruiting', 'recruitment', 'people & culture', 'people and culture',
            'public relations', 'growth marketing', 'demand generation',
            // Sales (Explicitly excluded by user)
            'sales', 'business development', 'account management'
        ];

        const EXCLUDED_TITLE_KEYWORDS = [
            // HR only
            'chief hr', 'human resource', 'recruiter', ' recruiter', 'talent acquisition',
            'people partner', 'people & culture', 'people ops',
            // Marketing ops only (not 'marketing director' or CMO)
            'social media manager', 'content manager', 'growth hacker',
            'demand gen', 'campaign manager', 'seo manager', 'sem manager',
            // Pure sales roles
            'sales representative', 'account executive', 'sales manager',
            'business development representative', 'bdr', 'sdr'
        ];

        const isExcluded = (contact) => {
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());
            const title = (contact.jobTitle || '').toLowerCase();

            const deptMatch = depts.length > 0 && depts.some(d => EXCLUDED_DEPARTMENTS.some(ex => d === ex || d.startsWith(ex)));
            const titleMatch = EXCLUDED_TITLE_KEYWORDS.some(kw => title.includes(kw));

            return deptMatch || titleMatch;
        };

        const isSeniorEditor = (contact) => {
            const title = (contact.jobTitle || '').toLowerCase();
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());
            const isEditor = title.includes('editor') || depts.some(d => d.includes('editor'));
            if (!isEditor) return false;
            const seniorKeywords = ['senior', 'chief', 'executive', 'managing', 'head', 'director', 'vp', 'lead', 'principal', 'founder'];
            return seniorKeywords.some(kw => title.includes(kw));
        };

        const isTechOrManagement = (contact) => {
            const title = (contact.jobTitle || '').toLowerCase();
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());

            // Keywords for Technical, IT, and Engineering functions
            const techKeywords = ['tech', 'it ', 'information technology', 'engineering', 'product', 'software', 'cto', 'data', 'analytics', 'systems', 'digital', 'platform', 'infrastructure', 'security', 'science', 'developer', 'cloud', 'architecture'];
            // Keywords for General Management and Leadership
            const mgmtKeywords = ['ceo', 'founder', 'owner', 'president', 'director', 'vp', 'head', 'management', 'operations', 'md', 'chief', 'vice president', 'excellence', 'strategy', 'partner', 'principal'];

            // CAVEAT: If the title or department explicitly mentions editorial/content/writing,
            // the contact belongs in the Editor category regardless of their seniority (e.g. "Editorial Director")
            const isEditorRelated = title.includes('editor') || depts.some(d => d.includes('editor') || d.includes('writing') || d.includes('editing') || d.includes('content') || d.includes('journalism'));
            if (isEditorRelated) return false;

            const hasTech = techKeywords.some(kw => title.includes(kw) || depts.some(d => d.includes(kw)));
            const hasMgmt = mgmtKeywords.some(kw => title.includes(kw) || depts.some(d => d.includes(kw)));

            return hasTech || hasMgmt;
        };

        // A contact passes pre-enrich if:
        //   1. Not excluded (HR, sales reps etc)
        //   2. AND either: (a) matches tech/mgmt keywords, (b) is a senior editor, OR
        //                  (c) has NO department info at all (common in smaller/regional companies)
        const hasDeptInfo = (c) => (c.departments || []).length > 0;

        const techContacts = searchContacts.filter(c => !isExcluded(c) && isTechOrManagement(c));
        const editorContacts = searchContacts.filter(c => !isExcluded(c) && isSeniorEditor(c) && !isTechOrManagement(c));
        const noDeptContacts = searchContacts.filter(c => !isExcluded(c) && !hasDeptInfo(c) && !techContacts.includes(c) && !editorContacts.includes(c));

        const relevantContacts = [...techContacts, ...editorContacts, ...noDeptContacts];
        console.log(`Pre-enrich: ${techContacts.length} Tech/Mgmt, ${editorContacts.length} Senior Editors, ${noDeptContacts.length} No-dept contacts.`);

        const contactIds = relevantContacts.map(c => c.contactId || c.id || c.personId).filter(id => id);
        console.log(`Step 2: Enriching ${contactIds.length} contacts...`);

        const idsToEnrich = contactIds.slice(0, 15);
        const enrichResponse = await withRetry(() => axios.post(
            '/api/lusha/prospecting/contact/enrich',
            {
                requestId: requestId,
                contactIds: idsToEnrich
            },
            {
                headers: {
                    'api_key': LUSHA_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        ), {
            initialDelay: 2000,
            onRetry: (count, delay) => onRetry?.(`Lusha Enrich (${count}/5)`, delay)
        });

        // Process Enrich Response
        const enrichedContactsRaw = enrichResponse.data.contacts || [];
        const targetSearch = cleanDomainForMatch(domain);
        console.log(`Step 2: Processing ${enrichedContactsRaw.length} enriched contacts for domain: ${domain}`);

        // Map to flat structure and filter
        const finalContacts = enrichedContactsRaw
            .filter(item => item.isSuccess && item.data)
            .map(item => item.data)
            .filter(contact => {
                // Second-pass exclusion filter
                if (isExcluded(contact)) {
                    console.log(`Post-enrich excluded: ${contact.fullName} — ${contact.jobTitle}`);
                    return false;
                }

                const noDept = !hasDeptInfo(contact);
                const passesRole = isTechOrManagement(contact) || isSeniorEditor(contact) || noDept;
                if (!passesRole) {
                    console.log(`Post-enrich role-filtered: ${contact.fullName} — ${contact.jobTitle}`);
                    return false;
                }

                // Must have some contact method
                const hasEmail = contact.emailAddresses && contact.emailAddresses.length > 0;
                const hasPhone = contact.phoneNumbers && contact.phoneNumbers.length > 0;
                const hasLinkedin = contact.socialLinks && contact.socialLinks.linkedin;

                if (!(hasEmail || hasPhone || hasLinkedin)) return false;

                // Flexible matching:
                // 1. Direct Domain Match (full or base)
                // 2. Company Name Match (if search was triggered by name or we have a known company name)

                const contactDomainObj = cleanDomainForMatch(contact.company?.fqdn || contact.fqdn);
                const isFullMatch = contactDomainObj.full && (contactDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(contactDomainObj.full));
                const isBaseMatch = (contactDomainObj.base && targetSearch.base) &&
                    (contactDomainObj.base === targetSearch.base || contactDomainObj.base.includes(targetSearch.base) || targetSearch.base.includes(contactDomainObj.base));

                // Allow match if company name matches the search name or vice-versa
                const contactCompanyName = (contact.companyName || contact.company?.name || '').toLowerCase();
                const searchedCompanyName = (companyName || '').toLowerCase();
                const isNameMatch = searchedCompanyName && contactCompanyName &&
                    (contactCompanyName.includes(searchedCompanyName) || searchedCompanyName.includes(contactCompanyName));

                const isMatch = isFullMatch || isBaseMatch || isNameMatch || isParent;

                if (!isMatch) {
                    console.log(`Filtering out ${contact.fullName} - match failed for domain ${contactDomainObj.full} and name ${contactCompanyName}`);
                }
                return isMatch;
            });

        console.log(`Filtered down to ${finalContacts.length} verified contacts.`);

        // Extract company info from first enriched contact
        let companyInfo = {
            name: 'Unknown Company',
            domain: domain
        };

        if (finalContacts.length > 0) {
            const first = finalContacts[0];
            if (first.companyName) companyInfo.name = first.companyName;
            const cDomain = first.company?.fqdn || first.fqdn;
            if (cDomain) companyInfo.domain = cDomain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');
        }

        // STEP 3: Verify current employment status via LinkedIn
        console.log(`Step 3: Verifying current employment for ${finalContacts.length} contacts...`);

        const verifyContact = async (contact) => {
            if (!contact.socialLinks || !contact.socialLinks.linkedin) return contact;

            try {
                const personResponse = await withRetry(() => axios.get('/api/lusha/v2/person', {
                    params: { linkedinUrl: contact.socialLinks.linkedin },
                    headers: { 'api_key': LUSHA_API_KEY }
                }), {
                    initialDelay: 1500,
                    onRetry: (count, delay) => onRetry?.(`Verify ${contact.fullName} (${count}/5)`, delay)
                });

                const personData = personResponse.data?.contact?.data;
                if (!personData) {
                    console.log(`No person data for ${contact.fullName}, keeping as potential.`);
                    return contact;
                }

                if (isParent) return contact;

                const currentCompany = personData.company;
                const currentDomainObj = cleanDomainForMatch(currentCompany?.fqdn || currentCompany?.domain);

                const isMatch = currentDomainObj.full && (currentDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(currentDomainObj.full)) ||
                    (currentDomainObj.base && currentDomainObj.base === targetSearch.base);

                if (!isMatch) {
                    console.log(`Verification: ${contact.fullName} seems to be at ${currentDomainObj.full} now. Marking as probable.`);
                    contact.probableFormer = true;
                }

                return contact;
            } catch (error) {
                console.warn(`Verification error for ${contact.fullName}:`, error.message);
                return contact; // Keep contact anyway
            }
        };

        const BATCH_SIZE = 2;
        const verifiedCurrentEmployees = [];

        for (let i = 0; i < finalContacts.length; i += BATCH_SIZE) {
            const batch = finalContacts.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(contact => verifyContact(contact)));
            batchResults.forEach(result => { if (result) verifiedCurrentEmployees.push(result); });
            if (i + BATCH_SIZE < finalContacts.length) await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`Final Result: ${verifiedCurrentEmployees.length} verified current employees.`);

        return {
            contacts: verifiedCurrentEmployees,
            requestId: enrichResponse.data.requestId || requestId,
            companyInfo
        };

    } catch (err) {
        console.error("Lusha API Error:", err);
        throw new Error(err.message || 'Failed to fetch decision makers.');
    }
};
