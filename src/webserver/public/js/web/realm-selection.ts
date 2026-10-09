
function getCookie(name: string): string | undefined {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(';').shift();
}

const token = getCookie('token');
if (!token) {

    window.location.href = '/';
}

// A login started from the documentation site (/docs) returns there.
const docsReturn = sessionStorage.getItem('docs-return');
if (token && docsReturn !== null) {
    sessionStorage.removeItem('docs-return');
    window.location.href = '/docs' + docsReturn;
}

// Same for a login started from the gateway dashboard (js/web/login.ts).
if (token && sessionStorage.getItem('login-return') === '/gateway') {
    sessionStorage.removeItem('login-return');
    window.location.href = '/gateway';
}

let selectedServerId: string | null = null;
let servers: any[] = [];
const serverPings = new Map<string, number>();

const REFRESH_INTERVAL_MS = 5000;
let lastRefreshAt = 0;
let loadInFlight = false;

async function measureServerPing(server: any): Promise<number | null> {
    try {
        const protocol = server.useSSL ? 'https' : 'http';
        const url = `${protocol}://${server.publicHost}:${server.port}/ping`;

        const start = performance.now();
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-cache',
            mode: 'cors'
        });

        if (response.ok) {
            const end = performance.now();
            const ping = Math.round(end - start);
            serverPings.set(server.id, ping);
            return ping;
        }
    } catch (error) {
        console.error(`Failed to ping server ${server.id}:`, error);
    }
    return null;
}

async function measureAllPings(): Promise<void> {

    const onlineServers = servers.filter(s => s.status !== 'offline');
    await Promise.all(onlineServers.map(server => measureServerPing(server)));
    renderServers();
}

async function loadServers(): Promise<void> {
    if (loadInFlight) return;
    loadInFlight = true;
    try {
        const loadingEl = document.getElementById('loading-message');
        if (loadingEl) {
            loadingEl.innerHTML = 'Loading available realms...';
        }

        const timestamp = Date.now();
        const response = await fetch(`/api/gateway/servers?t=${timestamp}`, {
            cache: 'no-store'
        });

        if (!response.ok) {
            throw new Error('Failed to fetch servers');
        }

        const data = await response.json();
        servers = data.servers;
        serverPings.clear();

        renderServers();
        lastRefreshAt = Date.now();
        updateRefreshTimestamp();

        await measureAllPings();
    } catch (error) {
        const loadingEl = document.getElementById('loading-message');
        if (loadingEl) {
            loadingEl.innerHTML =
                `<span class="realm-load-error">Failed to load realms. Please try refreshing.</span>`;
        }
    } finally {
        loadInFlight = false;
    }
}

function renderServers(): void {
    const realmList = document.getElementById('realm-list');
    if (!realmList) return;

    if (servers.length === 0) {
        realmList.innerHTML = '<div id="loading-message">No realms available. Please try again later.</div>';
        return;
    }

    realmList.innerHTML = servers.map((server, index) => {
        const status = server.status;

        const realmName = server.id;

        let statusClass = 'healthy';
        let statusText = 'Online';

        if (status === 'offline') {
            statusClass = 'alert';
            statusText = 'Offline';
        } else if (status === 'full') {
            statusClass = 'degraded';
            statusText = 'Full';
        }

        const clientPing = serverPings.get(server.id);
        const latencyDisplay = clientPing !== undefined
            ? `${clientPing}ms`
            : (status === 'offline' ? 'offline' : '<span class="realm-measuring">measuring...</span>');

        // Build status badges (whitelist first, then status)
        const statusBadges = [];

        if (server.whitelisted) {
            statusBadges.push(`<div class="realm-status whitelist">whitelist</div>`);
        }

        statusBadges.push(`<div class="realm-status ${statusClass}">${statusText}</div>`);

        return `
            <div class="realm-card${status === 'offline' ? ' disabled' : ''}${server.id === selectedServerId ? ' selected' : ''}" data-server-id="${server.id}" ${status === 'offline' ? 'style="pointer-events: none; opacity: 0.5;"' : ''}>
                <div class="realm-card-info">
                    <div class="realm-name">${realmName}</div>
                    <div class="realm-card-stats">
                        <div class="realm-metric">
                            <span class="realm-metric-label">Players:</span>
                            <span class="realm-metric-value">${server.activeConnections}/${server.maxConnections}</span>
                        </div>
                    </div>
                </div>
                <div class="realm-right">
                    <div class="realm-badges">
                        ${statusBadges.join('')}
                    </div>
                    <div class="realm-latency">${latencyDisplay}</div>
                </div>
            </div>
            <div class="realm-divider"></div>
        `;
    }).join('');

    document.querySelectorAll('.realm-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.realm-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedServerId = (card as HTMLElement).dataset.serverId || null;
            const continueBtn = document.getElementById('continue-button') as HTMLButtonElement;
            if (continueBtn) continueBtn.disabled = false;

            // Hide no-selection message and show realm details
            const detailsContent = document.getElementById('details-content');
            if (detailsContent) {
                const message = document.getElementsByClassName('no-selection')[0] as HTMLElement;
                const server = servers.find(s => s.id === selectedServerId);
                if (message && server) {
                    message.innerHTML = `
                        <div class="no-selection-icon">⚔️</div>
                        <h3>${server.id}</h3>
                        <p>${server.description || 'No description available.'}</p>
                    `;
                }
            }

            // Reveal the details panel (on mobile it only appears after a
            // selection) and bring it into view on small screens. Joining
            // always goes through the Enter Realm button.
            document.body.classList.add('has-selection');
            const detailsWrapper = document.querySelector('.realm-details-wrapper');
            if (detailsWrapper && window.matchMedia('(max-width: 768px)').matches) {
                const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
                detailsWrapper.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
            }
        });
    });
}

// When the realm's Log In lock needs a subscription and this account has none (and is not an admin), the
// game would refuse it at login with no reason shown. Say it here instead.
async function showSubscriptionNeeded(): Promise<boolean> {
    const notice = document.getElementById('subscription-needed');
    let needed = false;
    let guest = false;
    try {
        const response = await fetch('/api/subscription', {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store'
        });
        if (response.ok) {
            const info = await response.json();
            needed = !!info.loginLocked;
            guest = !!info.guest;
        }
    } catch {
        // Not knowing is not a reason to keep a player out: the game decides.
    }
    notice?.classList.toggle('show', needed);
    // A guest cannot subscribe, so there is nowhere for the button to lead.
    document.getElementById('subscribe-button')?.classList.toggle('hidden', guest);
    return needed;
}

document.getElementById('subscribe-button')?.addEventListener('click', () => {
    window.location.href = '/manage-profile';
});

async function continueToGame(serverId: string | null): Promise<void> {
    if (await showSubscriptionNeeded()) return;
    if (serverId) {

        localStorage.setItem('selectedServerId', serverId);
    } else {

        localStorage.removeItem('selectedServerId');
    }
    window.location.href = '/game';
}

document.getElementById('continue-button')?.addEventListener('click', () => {
    continueToGame(selectedServerId);
});

function updateRefreshTimestamp(): void {
    const el = document.getElementById('refresh-timestamp');
    if (!el) return;
    if (!lastRefreshAt) {
        el.textContent = 'Loading…';
        return;
    }
    const secs = Math.max(0, Math.round((Date.now() - lastRefreshAt) / 1000));
    el.textContent = secs <= 1
        ? 'Last refreshed just now'
        : secs < 60
            ? `Last refreshed ${secs}s ago`
            : `Last refreshed ${Math.round(secs / 60)}m ago`;
}

function startAutoRefresh(): void {
    window.setInterval(updateRefreshTimestamp, 1000);
    window.setInterval(() => {
        if (document.hidden || loadInFlight) return; // skip background tabs and slow fetches
        loadServers();
    }, REFRESH_INTERVAL_MS);
}

updateRefreshTimestamp();
loadServers();
startAutoRefresh();
if (token) void showSubscriptionNeeded();
