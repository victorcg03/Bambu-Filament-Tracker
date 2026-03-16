// =============================================================================
// Filament Tracker — Frontend JavaScript
// =============================================================================

const POLL_INTERVAL = 5000; // 5 seconds
const API_KEY = document.querySelector('meta[name="api-key"]')?.content || '';

let spoolsData = [];
let statusData = {};
let amsInfo = {};
let trayNow = -1;
let currentSort = 'last_seen';

// ---- Helpers ----

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseColor(hex) {
    const h = (hex || 'CCCCCCFF').replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.substring(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
}

function hexToRgb(hex) {
    const c = parseColor(hex);
    return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function hexToRgba(hex) {
    const c = parseColor(hex);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

function isTransparent(hex) {
    const c = parseColor(hex);
    return c.a < 0.9;
}

function timeAgo(isoStr) {
    if (!isoStr) return 'Unknown';
    const date = new Date(isoStr + 'Z');
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function materialBadgeClass(material) {
    const m = (material || '').toLowerCase();
    if (m.includes('petg')) return 'petg';
    if (m.includes('abs')) return 'abs';
    if (m.includes('tpu')) return 'tpu';
    if (m.includes('pa') || m.includes('nylon')) return 'pa';
    if (m.includes('pc')) return 'pc';
    if (m.includes('pva')) return 'pva';
    return '';
}

function spoolName(spool) {
    if (spool.custom_name) return spool.custom_name;
    return `${spool.material_type || 'Unknown'}`;
}

function createSpoolIcon(colorHex, remainPercent, size) {
    const color = hexToRgba(colorHex || 'CCCCCCFF');
    const pct = Math.max(0, Math.min(100, remainPercent || 0));
    const el = document.createElement('div');
    el.className = 'spool-icon';
    if (isTransparent(colorHex)) el.classList.add('transparent');
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.background = `conic-gradient(${color} 0% ${pct}%, #333 ${pct}% 100%)`;
    return el;
}

// ---- Sorting ----

function sortSpools(spools, sortKey) {
    const sorted = [...spools];
    switch (sortKey) {
        case 'weight_asc':
            sorted.sort((a, b) => a.remaining_grams - b.remaining_grams);
            break;
        case 'weight_desc':
            sorted.sort((a, b) => b.remaining_grams - a.remaining_grams);
            break;
        case 'percent_asc':
            sorted.sort((a, b) => a.remain_percent - b.remain_percent);
            break;
        case 'percent_desc':
            sorted.sort((a, b) => b.remain_percent - a.remain_percent);
            break;
        case 'material':
            sorted.sort((a, b) => (a.material_type || '').localeCompare(b.material_type || ''));
            break;
        case 'name':
            sorted.sort((a, b) => spoolName(a).localeCompare(spoolName(b)));
            break;
        case 'last_seen':
        default:
            sorted.sort((a, b) => {
                // Active first, then by last_seen descending
                if (a.is_active !== b.is_active) return b.is_active - a.is_active;
                return (b.last_seen || '').localeCompare(a.last_seen || '');
            });
            break;
    }
    return sorted;
}

// ---- API ----

async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function loadAll() {
    try {
        const [spools, status, alerts, settings] = await Promise.all([
            fetchJSON('/api/spools'),
            fetchJSON('/api/status'),
            fetchJSON('/api/alerts'),
            fetchJSON('/api/settings/alert_threshold'),
        ]);
        spoolsData = spools;
        statusData = status;
        amsInfo = status.ams_info || {};
        trayNow = status.tray_now != null ? status.tray_now : -1;
        renderHeader(status);
        renderAMS(spools);
        renderInventory(spools);
        renderAlertsPanel(alerts);

        // Sync threshold input (only if user isn't focused on it)
        const input = document.getElementById('threshold-input');
        if (input && document.activeElement !== input) {
            input.value = settings.alert_threshold_grams;
        }
    } catch (err) {
        console.error('Failed to load data:', err);
    }
}

// ---- Render: Header ----

function renderHeader(status) {
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-label');
    const printInfo = document.getElementById('print-info');

    if (status.connected || status.test_mode) {
        dot.className = 'status-dot connected';
        label.textContent = 'Connected';
    } else {
        dot.className = 'status-dot disconnected';
        label.textContent = 'Disconnected';
    }

    if (status.gcode_state === 'RUNNING' && status.job_name) {
        printInfo.style.display = 'flex';
        document.getElementById('print-job-name').textContent = status.job_name;
        document.getElementById('print-percent').textContent = status.progress + '%';
        document.getElementById('print-bar-fill').style.width = status.progress + '%';
    } else {
        printInfo.style.display = 'none';
    }

    // AMS environment (temp & humidity)
    const envContainer = document.getElementById('ams-env');
    const info = status.ams_info || {};
    const keys = Object.keys(info).sort();
    if (keys.length === 0) {
        envContainer.innerHTML = '';
        return;
    }
    envContainer.innerHTML = keys.map(id => {
        const a = info[id];
        const unitLabel = a.tray_count === 1 ? 'HT' : parseInt(id) + 1;
        const temp = a.temp ? a.temp.toFixed(1) + '\u00B0C' : '--';
        const hum = a.humidity ? a.humidity + '%' : (a.humidity_index ? a.humidity_index + '/5' : '--');
        return `<div class="ams-env-item"><span class="ams-env-label">AMS ${escapeHtml(String(unitLabel))}</span><span class="ams-env-temp">${escapeHtml(temp)}</span><span class="ams-env-hum">${escapeHtml(hum)}</span></div>`;
    }).join('');
}

// ---- Render: AMS Active Spools ----

function renderAMS(spools) {
    const container = document.getElementById('ams-container');
    container.innerHTML = '';

    const active = spools.filter(s => s.is_active);
    if (active.length === 0) {
        container.innerHTML = '<p class="loading">No spools currently loaded in AMS</p>';
        return;
    }

    const units = {};
    active.forEach(s => {
        const u = s.last_ams_unit || 0;
        if (!units[u]) units[u] = [];
        units[u].push(s);
    });

    // Include AMS units that have amsInfo but no active spools (empty AMS-HT etc.)
    Object.keys(amsInfo).forEach(id => {
        if (!units[id]) units[id] = [];
    });

    Object.keys(units).sort().forEach(unitId => {
        const unitDiv = document.createElement('div');
        unitDiv.className = 'ams-unit';

        const info = amsInfo[unitId];
        const trayCount = info ? info.tray_count : 4;
        const isHT = trayCount === 1;

        const label = document.createElement('div');
        label.className = 'ams-unit-label';
        label.textContent = isHT ? 'AMS-HT' : `AMS ${parseInt(unitId) + 1}`;
        unitDiv.appendChild(label);

        const row = document.createElement('div');
        row.className = 'ams-tray-row';
        if (isHT) row.classList.add('ams-ht');

        const slotMap = {};
        units[unitId].forEach(s => { slotMap[s.last_tray_slot] = s; });

        for (let slot = 0; slot < trayCount; slot++) {
            const spool = slotMap[slot];
            if (spool) {
                row.appendChild(createActiveCard(spool, slot));
            } else {
                row.appendChild(createEmptyCard(slot));
            }
        }

        unitDiv.appendChild(row);
        container.appendChild(unitDiv);
    });
}

function createActiveCard(spool, slot) {
    const card = document.createElement('div');
    const globalTray = (spool.last_ams_unit || 0) * 4 + slot;
    card.className = 'spool-card' + (globalTray === trayNow ? ' printing' : '');
    card.onclick = () => openDetail(spool.tray_uuid);

    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.textContent = slot + 1;
    card.appendChild(badge);

    const isNonRfid = spool.is_rfid === 0;
    card.appendChild(createSpoolIcon(spool.color_hex, isNonRfid ? 100 : spool.remain_percent, 72));

    const mat = document.createElement('div');
    mat.className = 'spool-card-material';
    mat.textContent = spool.material_type || 'Unknown';
    card.appendChild(mat);

    if (isNonRfid) {
        const norfid = document.createElement('div');
        norfid.className = 'norfid-label';
        norfid.textContent = 'Non-RFID';
        card.appendChild(norfid);
    } else {
        const weight = document.createElement('div');
        weight.className = 'spool-card-weight' + (spool.is_low ? ' low' : '');
        weight.textContent = spool.remaining_grams + 'g';
        card.appendChild(weight);

        const pct = document.createElement('div');
        pct.className = 'spool-card-percent';
        pct.textContent = spool.remain_percent + '%';

        const bar = document.createElement('div');
        bar.className = 'progress-bar';
        const fill = document.createElement('div');
        fill.className = 'progress-bar-fill';
        fill.style.width = spool.remain_percent + '%';
        fill.style.background = hexToRgb(spool.color_hex);
        bar.appendChild(fill);
        pct.appendChild(bar);
        card.appendChild(pct);

        if (spool.is_low) {
            const warn = document.createElement('div');
            warn.className = 'low-indicator';
            warn.textContent = 'LOW';
            card.appendChild(warn);
        }
    }

    if (globalTray === trayNow) {
        const tag = document.createElement('div');
        tag.className = 'in-use-tag';
        tag.textContent = 'In Use';
        card.appendChild(tag);
    }

    return card;
}

function createEmptyCard(slot) {
    const card = document.createElement('div');
    card.className = 'spool-card empty';

    const badge = document.createElement('div');
    badge.className = 'slot-badge';
    badge.textContent = slot + 1;
    card.appendChild(badge);

    const label = document.createElement('div');
    label.className = 'empty-label';
    label.textContent = 'Empty';
    card.appendChild(label);

    return card;
}

// ---- Render: Inventory ----

function renderInventory(spools) {
    const grid = document.getElementById('inventory-grid');
    grid.innerHTML = '';

    if (spools.length === 0) {
        grid.innerHTML = '<p class="loading">No spools tracked yet</p>';
        return;
    }

    const sorted = sortSpools(spools, currentSort);

    sorted.forEach(spool => {
        const card = document.createElement('div');
        card.className = 'inv-card';
        card.onclick = () => openDetail(spool.tray_uuid);

        const isNonRfid = spool.is_rfid === 0;
        card.appendChild(createSpoolIcon(spool.color_hex, isNonRfid ? 100 : spool.remain_percent, 52));

        const info = document.createElement('div');
        info.className = 'inv-card-info';

        const name = document.createElement('div');
        name.className = 'inv-card-name';
        name.textContent = spoolName(spool);
        info.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'inv-card-meta';

        const matBadge = document.createElement('span');
        matBadge.className = 'material-badge ' + materialBadgeClass(spool.material_type);
        matBadge.textContent = spool.material_type || '?';
        meta.appendChild(matBadge);

        const statusBadge = document.createElement('span');
        statusBadge.className = 'status-badge ' + (spool.is_active ? 'active' : 'stored');
        statusBadge.textContent = spool.is_active ? 'In AMS' : 'Stored';
        meta.appendChild(statusBadge);

        if (isNonRfid) {
            const norfidBadge = document.createElement('span');
            norfidBadge.className = 'status-badge norfid';
            norfidBadge.textContent = 'Non-RFID';
            meta.appendChild(norfidBadge);
        }

        if (spool.is_active && (spool.last_ams_unit || 0) * 4 + (spool.last_tray_slot || 0) === trayNow) {
            const inUseBadge = document.createElement('span');
            inUseBadge.className = 'in-use-tag';
            inUseBadge.textContent = 'In Use';
            meta.appendChild(inUseBadge);
        }

        info.appendChild(meta);

        if (!isNonRfid) {
            const weightLine = document.createElement('div');
            weightLine.className = 'inv-card-weight';
            weightLine.textContent = `${spool.remaining_grams}g / ${spool.spool_weight}g`;
            info.appendChild(weightLine);
        }

        const timeLine = document.createElement('div');
        timeLine.className = 'inv-card-time';
        timeLine.textContent = 'Last seen: ' + timeAgo(spool.last_seen);
        info.appendChild(timeLine);

        card.appendChild(info);
        grid.appendChild(card);
    });
}

// ---- Render: Alerts Panel ----

function renderAlertsPanel(alerts) {
    const list = document.getElementById('alerts-list');

    if (!alerts || alerts.length === 0) {
        list.innerHTML = '<p class="alerts-empty">No low stock alerts</p>';
        return;
    }

    list.innerHTML = '';
    alerts.forEach(a => {
        const item = document.createElement('div');
        item.className = 'alert-card';

        const colorBar = document.createElement('div');
        colorBar.className = 'alert-color-bar';
        colorBar.style.background = hexToRgb(a.color || 'FFFFFFFF');
        item.appendChild(colorBar);

        const content = document.createElement('div');
        content.className = 'alert-card-content';

        const title = document.createElement('div');
        title.className = 'alert-card-title';
        title.textContent = `${a.material}`;
        content.appendChild(title);

        const detail = document.createElement('div');
        detail.className = 'alert-card-detail';
        detail.textContent = `${a.remaining_grams}g remaining`;
        content.appendChild(detail);

        const location = document.createElement('div');
        location.className = 'alert-card-location';
        location.textContent = `AMS ${(a.ams_unit || 0) + 1}, Slot ${(a.tray_slot || 0) + 1}`;
        content.appendChild(location);

        item.appendChild(content);

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'alert-card-dismiss';
        dismissBtn.innerHTML = '&times;';
        dismissBtn.title = 'Dismiss alert';
        dismissBtn.onclick = (e) => {
            e.stopPropagation();
            dismissAlert(a.tray_uuid);
        };
        item.appendChild(dismissBtn);

        list.appendChild(item);
    });
}

async function dismissAlert(trayUuid) {
    try {
        await fetch(`/api/alerts/${trayUuid}`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } });
        loadAll();
    } catch (err) {
        console.error('Failed to dismiss alert:', err);
    }
}

async function saveThreshold() {
    const input = document.getElementById('threshold-input');
    const val = parseInt(input.value);
    if (isNaN(val) || val < 0) return;

    try {
        await fetch('/api/settings/alert_threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
            body: JSON.stringify({ alert_threshold_grams: val }),
        });
        loadAll();
    } catch (err) {
        console.error('Failed to save threshold:', err);
    }
}

// ---- Modal / Detail View ----

let chartInstance = null;

async function openDetail(trayUuid) {
    const overlay = document.getElementById('modal-overlay');
    overlay.classList.add('open');

    const modal = document.getElementById('modal-content');
    modal.innerHTML = '<p class="loading">Loading...</p>';

    try {
        const spool = await fetchJSON(`/api/spools/${trayUuid}`);
        renderModal(spool);
    } catch (err) {
        modal.innerHTML = '<p class="loading">Failed to load spool details.</p>';
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

function renderModal(spool) {
    const modal = document.getElementById('modal-content');

    modal.innerHTML = `
        <button class="modal-close" id="modal-close-btn">&times;</button>
        <div class="modal-header">
            <div id="modal-spool-icon"></div>
            <div>
                <div class="modal-title">${escapeHtml(spoolName(spool))}</div>
                <div class="modal-subtitle">${escapeHtml(spool.material_type || '')} &middot; #${escapeHtml((spool.color_hex || '').substring(0, 6))}${spool.is_rfid === 0 ? ' <span class="status-badge norfid">Non-RFID</span>' : ''}</div>
            </div>
        </div>

        <div class="detail-grid">
            ${spool.is_rfid !== 0 ? `<div class="detail-item">
                <div class="detail-label">Remaining</div>
                <div class="detail-value">${spool.remaining_grams}g / ${spool.spool_weight}g (${spool.remain_percent}%)${spool.weight_offset ? ' <span class="offset-badge">' + (spool.weight_offset > 0 ? '+' : '') + spool.weight_offset + 'g offset</span>' : ''}</div>
            </div>` : ''}
            <div class="detail-item">
                <div class="detail-label">Status</div>
                <div class="detail-value">${spool.is_active ? 'In AMS' : 'Stored'}${spool.is_rfid === 0 ? ' (Non-RFID)' : ''}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Nozzle Temp</div>
                <div class="detail-value">${spool.nozzle_temp_min || '?'} - ${spool.nozzle_temp_max || '?'}&deg;C</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Bed Temp</div>
                <div class="detail-value">${spool.bed_temp || '?'}&deg;C</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Diameter</div>
                <div class="detail-value">${spool.diameter || 1.75}mm</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">First Seen</div>
                <div class="detail-value">${timeAgo(spool.first_seen)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Last Seen</div>
                <div class="detail-value">${timeAgo(spool.last_seen)}</div>
            </div>
            <div class="detail-item">
                <div class="detail-label">Location</div>
                <div class="detail-value">AMS ${(spool.last_ams_unit || 0) + 1}, Slot ${(spool.last_tray_slot || 0) + 1}</div>
            </div>
        </div>

        <div class="editable-field">
            <label>Custom Name</label>
            <input type="text" id="edit-name" value="${escapeHtml(spool.custom_name || '')}" placeholder="Give this spool a name...">
        </div>
        ${spool.is_rfid !== 0 ? `<div class="editable-field">
            <label>Weight Offset (grams)</label>
            <input type="number" id="edit-offset" value="${spool.weight_offset || 0}" placeholder="0" step="1">
            <span class="field-hint">Adjust if the reported weight doesn't match reality. Use negative to reduce, positive to increase.</span>
        </div>` : ''}
        <div class="editable-field">
            <label>Notes</label>
            <textarea id="edit-notes" placeholder="Add notes...">${escapeHtml(spool.notes || '')}</textarea>
        </div>
        <div class="modal-actions">
            <button class="save-btn" id="modal-save-btn">Save Changes</button>
            <button class="delete-btn" id="modal-delete-btn">Delete Spool</button>
        </div>

        <div class="chart-section">
            <h3>Usage History</h3>
            ${spool.is_rfid === 0 ? '<p class="no-usage-note">Usage tracking is not available for non-RFID spools. Remaining percentage is an estimate based on AMS rotation tracking.</p>' : ''}
            <div class="chart-container"><canvas id="usage-chart"></canvas></div>
        </div>
    `;

    // Attach event listeners (inline onclick is blocked by CSP)
    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-save-btn').addEventListener('click', () => saveSpool(spool.tray_uuid));
    document.getElementById('modal-delete-btn').addEventListener('click', () => deleteSpool(spool.tray_uuid));

    const iconContainer = document.getElementById('modal-spool-icon');
    iconContainer.appendChild(createSpoolIcon(spool.color_hex, spool.remain_percent, 72));

    if (spool.history && spool.history.length > 0) {
        drawChart(spool.history, spool.color_hex);
    }
}

async function deleteSpool(trayUuid) {
    if (!confirm('Are you sure you want to delete this spool? This will remove all its history.')) return;
    try {
        await fetch(`/api/spools/${trayUuid}`, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } });
        closeModal();
        loadAll();
    } catch (err) {
        console.error('Failed to delete:', err);
    }
}

async function saveSpool(trayUuid) {
    const customName = document.getElementById('edit-name').value;
    const notes = document.getElementById('edit-notes').value;
    const offsetEl = document.getElementById('edit-offset');
    const payload = { custom_name: customName, notes: notes };
    if (offsetEl) {
        payload.weight_offset = parseInt(offsetEl.value) || 0;
    }

    try {
        await fetch(`/api/spools/${trayUuid}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
            body: JSON.stringify(payload),
        });
        loadAll();
    } catch (err) {
        console.error('Failed to save:', err);
    }
}

function drawChart(history, colorHex) {
    const ctx = document.getElementById('usage-chart');
    if (!ctx) return;

    const sorted = [...history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const labels = sorted.map(h => {
        const d = new Date(h.timestamp + 'Z');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    });
    const data = sorted.map(h => h.remain_percent);
    const color = hexToRgb(colorHex);

    if (typeof Chart === 'undefined') return;

    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Remaining %',
                data: data,
                borderColor: color,
                backgroundColor: color.replace('rgb', 'rgba').replace(')', ', 0.15)'),
                fill: true,
                tension: 0.3,
                pointRadius: 3,
                pointBackgroundColor: color,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { min: 0, max: 100, ticks: { color: '#9e9e9e' }, grid: { color: '#2a2a4a' } },
                x: { ticks: { color: '#9e9e9e', maxTicksLimit: 8 }, grid: { color: '#2a2a4a' } },
            },
            plugins: {
                legend: { display: false },
            }
        }
    });
}

// ---- Init ----

document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    setInterval(loadAll, POLL_INTERVAL);

    // Sort control
    document.getElementById('sort-select').addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderInventory(spoolsData);
    });

    // Threshold save
    document.getElementById('threshold-save').addEventListener('click', saveThreshold);
    document.getElementById('threshold-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveThreshold();
    });

    // Close modal on overlay click
    document.getElementById('modal-overlay').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
    });
});
