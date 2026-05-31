/**
 * Flyx Bypass v3 — Popup Controller
 *
 * Real-time dashboard with:
 * - Global stats + per-provider stats
 * - Category-grouped provider toggles
 * - Activity log (live via storage.onChanged)
 * - DLHD reCAPTCHA whitelist tool
 */

// ── State ───────────────────────────────────────────────────────────────

var state = {
  stats: {},
  providerState: {},
  activityLog: [],
  providers: {},
  categories: {}
};

var collapsed = {}; // category collapse state

// ── Load ────────────────────────────────────────────────────────────────

function load() {
  chrome.runtime.sendMessage({ type: 'getStatus' }).then(function (r) {
    if (r) {
      state.stats = r.stats || {};
      state.providerState = r.providerState || {};
      state.activityLog = r.activityLog || [];
      state.providers = r.providers || {};
      state.categories = r.categories || {};
    }
    render();
  }).catch(function () {
    // SW may be waking up — try storage directly
    chrome.storage.local.get(['stats', 'providerState', 'activityLog'], function (r) {
      if (r.stats) state.stats = r.stats;
      if (r.providerState) state.providerState = r.providerState;
      if (r.activityLog) state.activityLog = r.activityLog;
      render();
    });
  });
}

// ── Render ──────────────────────────────────────────────────────────────

function render() {
  renderGlobalStats();
  renderProviders();
  renderLog();
}

function renderGlobalStats() {
  var g = (state.stats && state.stats.global) ? state.stats.global : {};
  document.getElementById('sInt').textContent = fmt(g.intercepted || 0);
  document.getElementById('sOk').textContent = fmt(g.success || 0);
  document.getElementById('sErr').textContent = fmt(g.error || 0);
  document.getElementById('sM3').textContent = fmt(g.m3u8 || 0);
}

function renderProviders() {
  var container = document.getElementById('providers');
  if (!Object.keys(state.providers).length) {
    container.innerHTML = '<div style="text-align:center;color:#3f3f46;padding:8px;font-size:10px">Loading providers...</div>';
    return;
  }

  // Group by category
  var groups = {};
  for (var id in state.providers) {
    var p = state.providers[id];
    var cat = p.cat || 'other';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push({ id: id, name: p.name, cat: cat });
  }

  // Category order
  var catOrder = ['live', 'movies', 'anime', 'other'];
  var html = '';

  catOrder.forEach(function (catKey) {
    if (!groups[catKey] || !groups[catKey].length) return;
    var catInfo = state.categories[catKey] || { name: catKey, icon: '' };
    var isCollapsed = collapsed[catKey];
    var allOn = groups[catKey].every(function (p) { return state.providerState[p.id] !== false; });

    html += '<div class="cat-header' + (isCollapsed ? ' collapsed' : '') + '" data-cat="' + catKey + '">';
    html += '<h2>' + catInfo.icon + ' ' + catInfo.name + ' <span class="cat-arrow">&#9660;</span></h2>';
    html += '<span class="cat-toggle" data-cat="' + catKey + '">' + (allOn ? 'disable all' : 'enable all') + '</span>';
    html += '</div>';

    var bodyMaxH = groups[catKey].length * 32 + 4;
    html += '<div class="cat-body' + (isCollapsed ? ' hidden' : '') + '" style="max-height:' + bodyMaxH + 'px" data-cat="' + catKey + '">';

    groups[catKey].forEach(function (p) {
      var on = state.providerState[p.id] !== false;
      var ps = (state.stats && state.stats[p.id]) ? state.stats[p.id] : {};
      var succ = ps.success || 0;
      var fail = ps.error || 0;

      html += '<div class="provider-row' + (on ? '' : ' off') + '">';
      html += '<div class="provider-left">';
      html += '<span class="provider-dot ' + (on ? 'on' : 'off') + '"></span>';
      html += '<span class="provider-name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>';
      html += '</div>';
      html += '<div class="provider-stats">';
      if (succ > 0) html += '<span class="provider-stat succ">&#10003;' + fmt(succ) + '</span>';
      if (fail > 0) html += '<span class="provider-stat fail">&#10007;' + fmt(fail) + '</span>';
      html += '</div>';
      html += '<label class="toggle"><input type="checkbox" data-id="' + p.id + '"' + (on ? ' checked' : '') + '><span class="toggle-slider"></span></label>';
      html += '</div>';
    });

    html += '</div>';
  });

  container.innerHTML = html;

  // Wire up events
  container.querySelectorAll('.cat-header').forEach(function (el) {
    el.addEventListener('click', function (e) {
      if (e.target.closest('.cat-toggle')) return;
      var cat = this.dataset.cat;
      collapsed[cat] = !collapsed[cat];
      render();
    });
  });

  container.querySelectorAll('.cat-toggle').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      var cat = this.dataset.cat;
      var catProviders = groups[cat] || [];
      var allOn = catProviders.every(function (p) { return state.providerState[p.id] !== false; });
      var newState = !allOn;
      // Toggle all providers in this category
      catProviders.forEach(function (p) {
        state.providerState[p.id] = newState;
        chrome.runtime.sendMessage({ type: 'toggle', id: p.id, on: newState });
      });
      render();
    });
  });

  container.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      var id = this.dataset.id;
      var on = this.checked;
      state.providerState[id] = on;
      chrome.runtime.sendMessage({ type: 'toggle', id: id, on: on });
      render();
    });
  });
}

function renderLog() {
  var list = document.getElementById('logList');
  var log = state.activityLog || [];

  if (!log.length) {
    list.innerHTML = '<div class="log-empty">No activity yet</div>';
    return;
  }

  // Show last 30 entries
  var show = log.slice(0, 30);
  var html = '';
  show.forEach(function (entry) {
    var icon, iconCls;
    if (entry.type === 'success') { icon = '✓'; iconCls = 'ok'; }
    else if (entry.type === 'error') { icon = '✗'; iconCls = 'err'; }
    else { icon = '⚡'; iconCls = 'int'; }

    var d = new Date(entry.ts);
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    var pname = (state.providers[entry.provider] && state.providers[entry.provider].name) || entry.provider;

    html += '<div class="log-entry">';
    html += '<span class="log-time">' + time + '</span>';
    html += '<span class="log-icon ' + iconCls + '">' + icon + '</span>';
    html += '<span class="log-provider">' + esc(pname) + '</span>';
    html += '<span class="log-detail">' + esc(entry.detail || '') + '</span>';
    html += '</div>';
  });
  list.innerHTML = html;
  // Auto-scroll to top (newest entries are at top)
  list.scrollTop = 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── reCAPTCHA Whitelist ─────────────────────────────────────────────────

document.getElementById('wlBtn').addEventListener('click', function () {
  var ch = document.getElementById('wlChan').value.trim();
  if (!ch) return;
  var key = ch.startsWith('premium') ? ch : 'premium' + ch;
  var btn = document.getElementById('wlBtn');
  var st = document.getElementById('wlStatus');
  btn.disabled = true;
  btn.textContent = 'Solving...';
  st.innerHTML = '<span class="pending">Solving reCAPTCHA v3...</span>';
  chrome.runtime.sendMessage({ type: 'whitelist', ch: key }).then(function (r) {
    btn.disabled = false;
    btn.textContent = 'Solve';
    if (r && r.success) {
      st.innerHTML = '<span class="ok">&#10003; Token solved! IP whitelisted for ~20-30 min</span>';
    } else {
      st.innerHTML = '<span class="err">&#10007; ' + ((r && r.error) || 'Failed') + '</span>';
    }
  }).catch(function (e) {
    btn.disabled = false;
    btn.textContent = 'Solve';
    st.innerHTML = '<span class="err">&#10007; ' + e.message + '</span>';
  });
});

// ── Reset Stats ─────────────────────────────────────────────────────────

document.getElementById('resetBtn').addEventListener('click', function () {
  chrome.runtime.sendMessage({ type: 'resetStats' }).then(function (r) {
    if (r && r.stats) state.stats = r.stats;
    state.activityLog = [];
    render();
  });
});

// Clear activity log locally. The SW keeps its ring buffer;
// the popup view resets until the next storage.onChanged sync.
document.getElementById('logClear').addEventListener('click', function () {
  state.activityLog = [];
  render();
});

// ── Real-time updates via storage.onChanged ─────────────────────────────

chrome.storage.local.onChanged.addListener(function (changes) {
  var needsRender = false;

  if (changes.stats) {
    state.stats = changes.stats.newValue || {};
    needsRender = true;
  }
  if (changes.activityLog) {
    state.activityLog = changes.activityLog.newValue || [];
    needsRender = true;
  }
  if (changes.providerState) {
    state.providerState = changes.providerState.newValue || {};
    needsRender = true;
  }

  if (needsRender) render();
});

// ── Init ────────────────────────────────────────────────────────────────

load();
