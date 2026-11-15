// Token Launch Radar: the dashboard. Plain JavaScript, no framework, no network.
//
// It reads window.RADAR from data.js (written by main.ts from the same snapshot that
// built board.json), renders the board, and opens one protocol's detail. The detail view
// recomputes the row's implied value and its farm plan from the row's own figures and
// checks both against board.json's row: a screen the code cannot back up is a screen
// that counts for nothing, so the page says so when the two disagree.

(function () {
  'use strict';
  var R = window.RADAR;
  if (!R || !Array.isArray(R.rows)) {
    document.getElementById('top-meta').textContent = 'No radar data: data.js is missing or empty.';
    return;
  }
  var watchlist = new Set(R.watchlist_slugs || []);

  // ---------- formatting ----------
  function money(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(n >= 1e11 ? 0 : 2).replace(/\.00$/, '') + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return '$' + Math.round(n);
  }
  function moneyFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) {
    if (n === null || n === undefined) return '—';
    var s = (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    return s;
  }
  function pctClass(n) {
    if (n === null || n === undefined) return '';
    return n >= 0 ? 'pos' : 'neg';
  }
  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days < 30) return days + 'd';
    if (days < 365) return Math.floor(days / 30) + 'mo';
    var y = Math.floor(days / 365);
    var m = Math.floor((days % 365) / 30);
    return m > 0 ? y + 'y ' + m + 'mo' : y + 'y';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- the header, the lede, and the model panel ----------
  var topMeta = document.getElementById('top-meta');
  topMeta.textContent = 'Snapshot ' + R.as_of + ' · ' + R.board_size + ' pre-token protocols · model ' + R.model_version;
  document.getElementById('lede-text').textContent =
    'DefiLlama tracks ' + R.protocols_total + ' protocols in this snapshot. ' + R.board_size +
    ' of them record no token at all, and the watchlist rule keeps every one of them on the board: the ' +
    R.watchlist_size + ' watchlist protocols, plus ' + R.early_size +
    ' early protocols below the ' + money(R.floor_usd) + ' TVL floor. Rows are ranked by implied launch value, ' +
    'fitted from the live-token protocols in the same snapshot — never from a hand-kept list of names.';
  var top = R.rows[0];
  document.getElementById('lede-stats').innerHTML =
    'Top of the board: <b>' + esc(top.name) + '</b> at <b>' + moneyFull(top.implied_value_usd) + '</b> implied, on ' +
    moneyFull(top.tvl_usd) + ' of TVL. ' + R.live_size + ' live-token protocols sit apart as the market reference.';
  var fit = R.fit;
  document.getElementById('model-text').textContent =
    'Implied value = exp(' + fit.intercept.toFixed(4) + ' + ' + fit.slope.toFixed(4) + ' × ln(TVL)) × a category adjustment, ' +
    'times a growth tilt of 1 + clamp(7-day change, −40%, +80%) × 0.25, times a maturity tilt of 0.90–1.10 by age. ' +
    'The line and the category adjustments are fitted at run time from the ' + fit.live_n +
    ' live-token protocols in the snapshot that carry a market cap: value grows sublinearly with TVL, ' +
    'so a protocol ten times as big is worth about ' + Math.pow(10, fit.slope).toFixed(1) + ' times as much, not ten times.';
  document.getElementById('model-fine').textContent =
    'Growth and age barely move live multiples (r = −0.15 and −0.00 on this snapshot), so they enter only as small tilts. ' +
    'A protocol the fit has never seen a category for gets an adjustment of 0.';
  var tbody = document.querySelector('#residuals-table tbody');
  var res = Object.keys(fit.residuals).sort();
  tbody.innerHTML = res.map(function (c) {
    var v = fit.residuals[c];
    var adj = (Math.exp(v) - 1) * 100;
    return '<tr><td>' + esc(c) + '</td><td class="' + (adj >= 0 ? 'pos' : 'neg') + '">' + (adj >= 0 ? '+' : '') + adj.toFixed(1) + '%</td></tr>';
  }).join('') || '<tr><td colspan="2">No category carried enough live protocols to measure.</td></tr>';
  var val = fit.validation;
  document.getElementById('validation-text').textContent =
    'Blind test (5-fold, split by slug hash): the fitted model prices held-out live protocols with a median absolute log error of ' +
    val.median_abs_log_error + ', and ' + Math.round(val.within_2x * 100) + '% land within 2x of their market cap. ' +
    'A flat 0.25x TVL multiple scores ' + val.baseline_median_abs_log_error + ' and ' + Math.round(val.baseline_within_2x * 100) + '%.';
  document.getElementById('foot-text').textContent =
    'Snapshot ' + R.as_of + ' · source ' + R.source + ' · watchlist floor ' + moneyFull(R.floor_usd) + ' · ' +
    R.board_size + ' rows · model ' + R.model_version + ' fitted on ' + fit.live_n + ' live-token protocols.';

  // ---------- the filters ----------
  var state = { tab: 'pre', q: '', category: '', chain: '', minTvl: 0, minImplied: 0, sort: 'implied' };
  var qEl = document.getElementById('q');
  var catEl = document.getElementById('category');
  var chainEl = document.getElementById('chain');
  var minTvlEl = document.getElementById('min-tvl');
  var minImpliedEl = document.getElementById('min-implied');
  var sortEl = document.getElementById('sort');
  var countEl = document.getElementById('count');
  var bodyEl = document.getElementById('board-body');
  var emptyEl = document.getElementById('empty');
  var dialog = document.getElementById('detail');
  var detailBody = document.getElementById('detail-body');

  function fillSelect(el, values) {
    var cur = el.value;
    el.innerHTML = '<option value="">All ' + (el === catEl ? 'categories' : 'chains') + '</option>' +
      values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    if (values.indexOf(cur) >= 0) el.value = cur;
  }
  fillSelect(catEl, [...new Set(R.rows.map(function (r) { return r.category || 'No category'; }))].sort());
  fillSelect(chainEl, [...new Set(R.rows.flatMap(function (r) { return r.chains; }))].sort());

  // ---------- the farm plan, recomputed in the page from the row's own figures ----------
  function capitalFor(tvl) {
    if (tvl >= 5e9) return 250;
    if (tvl >= 1e9) return 150;
    if (tvl >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(row, capital, chain) {
    var c = (row.category || '').toLowerCase();
    var name = row.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('liquidity manager') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + '\'s main pool on ' + chain + ' and keep the position open.';
    if (c.indexOf('yield') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0 || c.indexOf('staking pool') >= 0) return 'Stake $' + capital + ' of the chain\'s staking asset through ' + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trad') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Mint $' + capital + ' of the protocol\'s yield asset on ' + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    if (c.indexOf('risk') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' risk vault on ' + chain + ' and keep the receipt.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function weeklyActionFor(row) {
    var c = (row.category || '').toLowerCase();
    if (c.indexOf('dex') >= 0 || c.indexOf('liquidity manager') >= 0) return 'a swap in the main pool or a small add and remove of liquidity';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0) return 'a borrow and repay, or a fresh supply';
    if (c.indexOf('yield') >= 0 || c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'a deposit into a vault, or a vote on its allocation';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('basis trad') >= 0) return 'a small trade, or a funding payment you let settle';
    if (c.indexOf('prediction') >= 0) return 'one market position, win or lose';
    if (c.indexOf('bridge') >= 0) return 'one bridge transfer';
    if (c.indexOf('rwa') >= 0) return 'a mint or a transfer of the yield asset';
    if (c.indexOf('risk') >= 0) return 'a deposit into a risk vault, or a vote on its curation';
    return 'a deposit, a swap, a borrow or a vote';
  }
  function recomputeFarm(row) {
    var chain = row.chains.length > 0 ? row.chains[0] : 'its main chain';
    var capital = capitalFor(row.tvl_usd);
    var hold = holdDaysFor(row.age_days);
    var weekly = weeklyActionFor(row);
    var steps = [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(row, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as ' + weekly + '.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'Before you withdraw, open ' + row.name + '\'s own points or rewards page from the link it publishes and claim only there, never from a message or an ad.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
    ];
    return steps.map(function (s) {
      var t = s.text + ' Cost: ' + s.cost + '. Time: ' + s.time + '.';
      if (t.length > 600) t = t.slice(0, 596) + '...';
      return t;
    });
  }

  // ---------- the board ----------
  function valueOf(row) {
    return state.tab === 'pre' ? row.implied_value_usd : (row.mcap_usd || 0);
  }
  function chainsShort(r) {
    if (r.chains.length === 0) return 'no chain';
    if (r.chains.length <= 3) return r.chains.join(', ');
    return r.chains.slice(0, 3).join(', ') + ' +' + (r.chains.length - 3) + ' more';
  }
  function filteredRows() {
    var pool = state.tab === 'pre' ? R.rows : R.live;
    var q = state.q.trim().toLowerCase();
    var out = pool.filter(function (r) {
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      if (state.category && (r.category || 'No category') !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      if (state.minImplied && valueOf(r) < state.minImplied) return false;
      return true;
    });
    var key = state.sort;
    out.sort(function (a, b) {
      if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (key === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (key === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (key === 'name') return a.name.localeCompare(b.name);
      return valueOf(b) - valueOf(a);
    });
    return out;
  }
  function render() {
    var rows = filteredRows();
    countEl.textContent = state.tab === 'pre'
      ? rows.length + ' of ' + R.rows.length + ' pre-token protocols'
      : rows.length + ' of ' + R.live.length + ' live-token protocols (market reference)';
    emptyEl.hidden = rows.length > 0;
    bodyEl.innerHTML = rows.map(function (r) {
      var isPre = state.tab === 'pre';
      var watch = isPre && watchlist.has(r.slug) ? ' <span class="watch">WATCHLIST</span>' : '';
      var value = isPre ? money(r.implied_value_usd) : money(r.mcap_usd);
      var token = isPre ? '<span class="badge pre">Pre-token</span>' : '<span class="badge live">Live · ' + money(r.mcap_usd) + '</span>';
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="num">' + (isPre ? r.rank : '—') + '</td>' +
        '<td><span class="name">' + esc(r.name) + '</span>' + watch + '<br><span class="sub">' + esc(r.slug) + ' · ' + esc(r.category || 'No category') + ' · ' + esc(chainsShort(r)) + '</span></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num"><strong>' + value + '</strong></td>' +
        '<td>' + token + '</td></tr>';
    }).join('');
  }

  // ---------- the detail view ----------
  function openDetail(slug) {
    var row = R.rows.find(function (r) { return r.slug === slug; });
    var isLive = !row;
    if (isLive) row = R.live.find(function (r) { return r.slug === slug; });
    if (!row) return;
    var html = '<h2>' + esc(row.name) + '</h2><p class="meta">' + esc(row.slug) + ' · ' + esc(row.category || 'No category') + ' · ' +
      esc(row.chains.join(', ') || 'no chain') + (watchlist.has(row.slug) ? ' · <span class="watch">On the watchlist</span>' : '') + '</p>';
    if (!isLive) {
      var base = Math.exp(fit.intercept + fit.slope * Math.log(row.tvl_usd) + (row.category_residual || 0));
      var recomputed = Math.max(1, Math.round(base * row.growth_multiplier * row.maturity_multiplier));
      var agrees = recomputed === row.implied_value_usd;
      html += '<div class="kv">' +
        '<div><div class="k">Implied value</div><div class="v">' + moneyFull(row.implied_value_usd) + '</div></div>' +
        '<div><div class="k">TVL</div><div class="v">' + moneyFull(row.tvl_usd) + '</div></div>' +
        '<div><div class="k">7-day change</div><div class="v ' + pctClass(row.change_7d) + '">' + pct(row.change_7d) + '</div></div>' +
        '<div><div class="k">Age</div><div class="v">' + ageText(row.age_days) + '</div></div></div>' +
        '<h3>How the value is built</h3><p>Base from TVL: <strong>' + moneyFull(row.base_usd) + '</strong> ' +
        '(the fitted line, category adjustment ' + ((Math.exp(row.category_residual || 0) - 1) * 100).toFixed(1) + '%). ' +
        'Growth tilt ×' + row.growth_multiplier.toFixed(4) + ', maturity tilt ×' + row.maturity_multiplier.toFixed(4) + '. ' +
        'Recomputed in this page: <strong>' + moneyFull(recomputed) + '</strong> — ' +
        (agrees ? 'it matches the board.' : 'it does NOT match the board; treat this row with suspicion.') + '</p>';
      var steps = row.farm_steps || [];
      var recomputedSteps = recomputeFarm(row);
      var planAgrees = steps.length === recomputedSteps.length && steps.every(function (s, i) { return s === recomputedSteps[i]; });
      html += '<h3>How to farm it</h3><ol>' + steps.map(function (s) {
        var m = s.match(/ Cost: (.*)\. Time: (.*)\.$/);
        var text = m ? s.slice(0, s.indexOf(' Cost:')) : s;
        var meta = m ? 'Cost: ' + m[1] + ' · Time: ' + m[2] : '';
        return '<li>' + esc(text) + (meta ? '<br><span class="step-meta">' + esc(meta) + '</span>' : '') + '</li>';
      }).join('') + '</ol>' +
        '<p class="fine">' + (planAgrees ? 'The plan above is the same one the board file carries, recomputed here from the protocol\'s own record.' :
          'The plan above comes from the board file; the page\'s recomputation disagrees, so treat the plan with suspicion.') + '</p>';
    } else {
      html += '<div class="kv">' +
        '<div><div class="k">Market cap</div><div class="v">' + moneyFull(row.mcap_usd || 0) + '</div></div>' +
        '<div><div class="k">TVL</div><div class="v">' + moneyFull(row.tvl_usd) + '</div></div>' +
        '<div><div class="k">7-day change</div><div class="v ' + pctClass(row.change_7d) + '">' + pct(row.change_7d) + '</div></div>' +
        '<div><div class="k">Multiple</div><div class="v">' + (row.mcap_usd ? (row.mcap_usd / row.tvl_usd).toFixed(2) + 'x' : '—') + '</div></div></div>' +
        '<p>This protocol already trades, so it is not on the ranked board. It is shown here as a live reference: ' +
        'its market cap is one of the ' + fit.live_n + ' the model was fitted on.</p>';
    }
    detailBody.innerHTML = html;
    if (!dialog.open) dialog.showModal();
  }
  bodyEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    openDetail(tr.getAttribute('data-slug'));
    setHash();
  });

  // ---------- tabs, filters, hash state ----------
  function setTab(tab) {
    state.tab = tab;
    document.getElementById('tab-pre').setAttribute('aria-selected', tab === 'pre' ? 'true' : 'false');
    document.getElementById('tab-live').setAttribute('aria-selected', tab === 'live' ? 'true' : 'false');
    render();
  }
  document.getElementById('tab-pre').addEventListener('click', function () { setTab('pre'); setHash(); });
  document.getElementById('tab-live').addEventListener('click', function () { setTab('live'); setHash(); });
  function readInputs() {
    state.q = qEl.value;
    state.category = catEl.value;
    state.chain = chainEl.value;
    state.minTvl = parseFloat(minTvlEl.value) || 0;
    state.minImplied = parseFloat(minImpliedEl.value) || 0;
    state.sort = sortEl.value;
  }
  [qEl, catEl, chainEl, minTvlEl, minImpliedEl, sortEl].forEach(function (el) {
    el.addEventListener('input', function () { readInputs(); render(); setHash(); });
    el.addEventListener('change', function () { readInputs(); render(); setHash(); });
  });
  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      sortEl.value = key === 'rank' || key === 'implied' ? 'implied' : key;
      readInputs();
      render();
      setHash();
    });
  });
  function setHash() {
    var parts = [];
    if (state.tab !== 'pre') parts.push('tab=' + state.tab);
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.category) parts.push('category=' + encodeURIComponent(state.category));
    if (state.chain) parts.push('chain=' + encodeURIComponent(state.chain));
    if (state.minTvl) parts.push('minTvl=' + state.minTvl);
    if (state.minImplied) parts.push('minImplied=' + state.minImplied);
    if (state.sort !== 'implied') parts.push('sort=' + state.sort);
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var params = new URLSearchParams(h);
    return {
      tab: params.get('tab'),
      q: params.get('q'),
      category: params.get('category'),
      chain: params.get('chain'),
      minTvl: params.get('minTvl'),
      minImplied: params.get('minImplied'),
      sort: params.get('sort'),
      p: params.get('p'),
    };
  }
  var initial = readHash();
  if (initial) {
    if (initial.tab === 'live') setTab('live');
    if (initial.q) qEl.value = initial.q;
    if (initial.category) catEl.value = initial.category;
    if (initial.chain) chainEl.value = initial.chain;
    if (initial.minTvl) minTvlEl.value = initial.minTvl;
    if (initial.minImplied) minImpliedEl.value = initial.minImplied;
    if (initial.sort) sortEl.value = initial.sort;
  }
  readInputs();
  render();
  if (initial && initial.p) openDetail(initial.p);
})();
