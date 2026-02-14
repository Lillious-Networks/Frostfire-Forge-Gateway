// Check if user is logged in
function getCookie(name: string): string | undefined {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(';').shift();
}

const token = getCookie('token');
if (!token) {
    // Not logged in, redirect to login
    window.location.href = '/';
}

let selectedServerId: string | null = null;
let servers: any[] = [];
let serverPings = new Map<string, number>(); // Store measured pings for each server

async function measureServerPing(server: any): Promise<number | null> {
    try {
        const protocol = server.useSSL ? 'https' : 'http';
        const url = `${protocol}://${server.publicHost}:${server.wsPort}/ping`;

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
        // Silently fail - server might be unreachable
    }
    return null;
}

async function measureAllPings(): Promise<void> {
    // Measure ping for all online servers (exclude offline only)
    const onlineServers = servers.filter(s => s.status !== 'offline');
    await Promise.all(onlineServers.map(server => measureServerPing(server)));
    renderServers(); // Re-render with updated pings
}

async function loadServers(): Promise<void> {
    try {
        const response = await fetch('/api/gateway/servers');

        if (!response.ok) {
            throw new Error('Failed to fetch servers');
        }

        const data = await response.json();
        servers = data.servers;

        renderServers();

        // Start measuring pings in background
        measureAllPings();
    } catch (error) {
        const loadingEl = document.getElementById('loading-message');
        if (loadingEl) {
            loadingEl.innerHTML =
                `<span style="color: #fca5a5;">Failed to load realms. <a href="#" onclick="location.reload()">Retry</a> or <a href="#" id="skip-link-error">skip</a>.</span>`;
        }

        document.getElementById('skip-link-error')?.addEventListener('click', (e) => {
            e.preventDefault();
            continueToGame(null);
        });
    }
}

function renderServers(): void {
    const realmList = document.getElementById('realm-list');
    if (!realmList) return;

    if (servers.length === 0) {
        realmList.innerHTML = '<div id="loading-message">No realms available. Please try again later.</div>';
        return;
    }

    realmList.innerHTML = servers.map(server => {
        const status = server.status; // online, offline, or full
        const connectionsPercentage = ((server.activeConnections / server.maxConnections) * 100).toFixed(0);

        // Extract subdomain (realm name) from publicHost and capitalize first letter
        const subdomain = server.publicHost.split('.')[0];
        const realmName = subdomain.charAt(0).toUpperCase() + subdomain.slice(1);

        // Map status to visual style
        let statusClass = 'healthy';
        let statusText = 'Online';

        if (status === 'offline') {
            statusClass = 'alert';
            statusText = 'Offline';
        } else if (status === 'full') {
            statusClass = 'degraded';
            statusText = 'Full';
        }

        // Use client-measured ping if available, otherwise show "measuring..."
        const clientPing = serverPings.get(server.id);
        const latencyDisplay = clientPing !== undefined
            ? `${clientPing}ms`
            : (status === 'offline' ? 'offline' : '<span style="color: #6366f1;">measuring...</span>');

        return `
            <div class="realm-card ${status === 'offline' ? 'disabled' : ''}" data-server-id="${server.id}" ${status === 'offline' ? 'style="pointer-events: none; opacity: 0.5;"' : ''}>
                <div class="realm-header">
                    <div class="realm-name">${realmName}</div>
                    <div class="realm-right">
                        <div class="realm-status ${statusClass}">${statusText}</div>
                        <div class="realm-latency">${latencyDisplay}</div>
                    </div>
                </div>
                <div class="realm-metrics">
                    <div class="realm-metric">
                        <span class="realm-metric-label">Players:</span>
                        <span class="realm-metric-value">${server.activeConnections}/${server.maxConnections}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Add click handlers
    document.querySelectorAll('.realm-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.realm-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedServerId = (card as HTMLElement).dataset.serverId || null;
            const continueBtn = document.getElementById('continue-button') as HTMLButtonElement;
            if (continueBtn) continueBtn.disabled = false;
        });
    });
}

function continueToGame(serverId: string | null): void {
    if (serverId) {
        // Store selected server for socket.ts to use
        localStorage.setItem('selectedServerId', serverId);
    } else {
        // Clear selection for round-robin
        localStorage.removeItem('selectedServerId');
    }
    window.location.href = '/game';
}

document.getElementById('continue-button')?.addEventListener('click', () => {
    continueToGame(selectedServerId);
});

document.getElementById('skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    continueToGame(null);
});

// Load servers on page load
loadServers();
