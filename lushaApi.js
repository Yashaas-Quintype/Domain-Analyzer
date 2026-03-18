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
        try {
            console.log(`Step 1: Searching decision makers for domain: ${targetDomain}...`);
            const searchResponse = await withRetry(() => axios.post(
                '/api/lusha/prospecting/contact/search',
                {
                    filters: {
                        contacts: { include: { seniority: [10, 9, 8, 7, 6, 5] } },
                        companies: { include: { domains: [targetDomain] } }
                    }
                },
                {
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
                        contacts: { include: { seniority: [10, 9, 8, 7, 6, 5] } },
                        companies: { include: { name: [name] } }
                    }
                },
                {
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
        if (searchContacts.length === 0 && domain.split('.').length > 2) {
            const root = domain.split('.').slice(-2).join('.');
            console.log(`No contacts for ${domain}, checking root: ${root}`);
            const rootResult = await performSearch(root);
            searchContacts = rootResult.searchContacts;
            requestId = rootResult.requestId || requestId;
        }

        // Fallback 2: Cleaned domain variant (removes 'limited', etc.)
        const variant = cleanDomainForSearch(domain);
        const currentDomainOnly = domain.replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/$/, '');

        if (variant !== currentDomainOnly && variant.includes('.')) {
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
        // Filter out irrelevant departments (HR, Marketing, Finance) before enrichment
        const EXCLUDED_DEPARTMENTS = [
            // HR
            'human resources', 'hr', 'people operations', 'talent acquisition',
            'recruiting', 'recruitment', 'people & culture', 'people and culture',
            // Marketing
            'marketing', 'brand', 'communications', 'public relations', 'pr',
            'content', 'social media', 'growth marketing', 'demand generation',
            // Finance
            'finance', 'financial', 'accounting', 'financial planning', 'fp&a',
            'treasury', 'accounts payable', 'accounts receivable', 'bookkeeping',
            'audit', 'tax', 'controller', 'revenue operations', 'billing', 'payroll'
        ];

        const EXCLUDED_TITLE_KEYWORDS = [
            // HR
            'hr ', 'chief hr', 'human resource', 'recruiter', 'talent', 'people ops',
            'people partner', 'people & culture',
            // Marketing
            'marketing', 'brand manager', 'social media', 'content manager',
            'public relations', 'communications manager', 'growth hacker',
            'demand gen', 'campaign manager',
            // Finance
            'finance', 'financial', 'accountant', 'accounting', 'treasurer',
            'bookkeeper', 'auditor', 'tax manager', 'tax director',
            'controller', 'cfo', 'chief financial', 'fp&a', 'revenue operations',
            'billing manager', 'payroll', 'accounts payable', 'accounts receivable',
            'head of finance', 'vp finance', 'director of finance'
        ];

        const isExcluded = (contact) => {
            const depts = (contact.departments || []).map(d => (typeof d === 'string' ? d : d?.name || '').toLowerCase());
            const title = (contact.jobTitle || '').toLowerCase();

            const deptMatch = depts.some(d => EXCLUDED_DEPARTMENTS.some(ex => d.includes(ex)));
            const titleMatch = EXCLUDED_TITLE_KEYWORDS.some(kw => title.includes(kw));

            return deptMatch || titleMatch;
        };

        const relevantContacts = searchContacts.filter(c => !isExcluded(c));
        console.log(`Pre-enrich: Filtered ${searchContacts.length - relevantContacts.length} irrelevant contacts. ${relevantContacts.length} remain.`);

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
                // Second-pass exclusion filter on enriched data (full dept/title now available)
                if (isExcluded(contact)) {
                    console.log(`Post-enrich excluded: ${contact.fullName} — ${contact.jobTitle}`);
                    return false;
                }

                // Must have some contact method
                const hasEmail = contact.emailAddresses && contact.emailAddresses.length > 0;
                const hasPhone = contact.phoneNumbers && contact.phoneNumbers.length > 0;
                const hasLinkedin = contact.socialLinks && contact.socialLinks.linkedin;

                if (!(hasEmail || hasPhone || hasLinkedin)) return false;

                // Lenient employment check
                if (isParent) return true;

                const contactDomainObj = cleanDomainForMatch(contact.company?.fqdn || contact.fqdn);

                // Match if full domain matches OR base name matches (handles .com vs .in etc)
                const isFullMatch = contactDomainObj.full && (contactDomainObj.full.includes(targetSearch.full) || targetSearch.full.includes(contactDomainObj.full));

                // Extra lenient base name matching (handles esakal matching sakal)
                const isBaseMatch = (contactDomainObj.base && targetSearch.base) &&
                    (contactDomainObj.base.includes(targetSearch.base) || targetSearch.base.includes(contactDomainObj.base));

                const isMatch = isFullMatch || isBaseMatch;

                if (!isMatch) {
                    console.log(`Filtering out ${contact.fullName} - domain mismatch: ${contactDomainObj.full} vs ${targetSearch.full}`);
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
