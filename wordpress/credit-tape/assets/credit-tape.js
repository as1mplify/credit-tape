/* Credit Tape — WordPress shortcode renderer. Data is inlined by PHP, so no fetch. */
(function () {
  'use strict';

  var DAYS = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095 };

  function fmt(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function delta(n) {
    if (n === null || n === undefined) return '—';
    var sign = n > 0 ? '+' : n < 0 ? '\u2212' : '';
    return sign + Math.abs(Math.round(n));
  }

  function dirClass(n) {
    if (n === null || n === undefined) return 'is-flat';
    if (n > 0.5) return 'is-up';
    if (n < -0.5) return 'is-down';
    return 'is-flat';
  }

  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
  }

  function renderCards(root, cfg) {
    var wrap = root.querySelector('.credit-tape-cards');
    if (!wrap || cfg.show === 'chart') {
      if (wrap) wrap.remove();
      return;
    }

    cfg.series.forEach(function (s) {
      var span = (s.high3y - s.low3y) || 1;
      var pct = Math.min(1, Math.max(0, (s.latest - s.low3y) / span));
      var then = (s.change1m === null || s.change1m === undefined) ? null : s.latest - s.change1m;
      var pctThen = then === null ? null : Math.min(1, Math.max(0, (then - s.low3y) / span));

      var card = document.createElement('div');
      card.className = 'credit-tape-card';
      card.innerHTML =
        '<div class="ct-head"><span class="ct-swatch"></span><span class="ct-name"></span></div>' +
        '<div class="ct-figure"><span class="ct-value"></span><span class="ct-unit">bps</span></div>' +
        '<dl class="ct-deltas">' +
          '<div><dt>1d</dt><dd data-k="change1d"></dd></div>' +
          '<div><dt>1w</dt><dd data-k="change1w"></dd></div>' +
          '<div><dt>1m</dt><dd data-k="change1m"></dd></div>' +
          '<div><dt>1y</dt><dd data-k="change1y"></dd></div>' +
        '</dl>' +
        '<div class="ct-rail">' +
          '<div class="ct-rail-track"><div class="ct-rail-line"></div>' +
            (pctThen === null ? '' : '<span class="ct-tick ct-tick--then" style="left:' + (pctThen * 100) + '%"></span>') +
            '<span class="ct-tick ct-tick--now"></span>' +
          '</div>' +
          '<div class="ct-rail-scale"><span></span><span></span></div>' +
          '<p class="ct-rail-caption"></p>' +
        '</div>';

      card.querySelector('.ct-swatch').style.background = s.color;
      card.querySelector('.ct-name').textContent = s.short;
      card.querySelector('.ct-value').textContent = fmt(s.latest);

      ['change1d', 'change1w', 'change1m', 'change1y'].forEach(function (k) {
        var dd = card.querySelector('[data-k="' + k + '"]');
        dd.textContent = delta(s[k]);
        dd.className = dirClass(s[k]);
      });

      var scale = card.querySelectorAll('.ct-rail-scale span');
      scale[0].textContent = fmt(s.low3y);
      scale[1].textContent = fmt(s.high3y);

      var pctInt = Math.round(pct * 100);
      card.querySelector('.ct-rail-caption').textContent =
        pctInt + 'th percentile of its 3-year range';

      var tick = card.querySelector('.ct-tick--now');
      tick.style.background = s.color;
      tick.style.left = '0%';

      wrap.appendChild(card);
      requestAnimationFrame(function () { tick.style.left = (pct * 100) + '%'; });
    });
  }

  function renderChart(root, cfg) {
    var frame = root.querySelector('.credit-tape-chart');
    if (!frame || cfg.show === 'cards') {
      if (frame) frame.remove();
      return;
    }
    if (typeof Chart === 'undefined') {
      frame.remove();
      return;
    }

    var days = DAYS[cfg.window] || 365;
    var cutoff = Date.now() - days * 86400000;
    var dark = cfg.theme === 'dark';
    var gridColor = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    var tickColor = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)';
    var font = { family: 'inherit', size: 11 };

    var datasets = cfg.series.map(function (s) {
      return {
        label: s.short,
        data: (s.observations || [])
          .filter(function (o) { return o[0] >= cutoff; })
          .map(function (o) { return { x: o[0], y: o[1] }; }),
        borderColor: s.color,
        backgroundColor: s.color,
        borderWidth: 1.75,
        pointRadius: 0,
        pointHitRadius: 12,
        tension: 0
      };
    });

    new Chart(frame.querySelector('canvas'), {
      type: 'line',
      data: { datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? false : { duration: 400 },
        scales: {
          x: {
            type: 'linear',
            grid: { color: gridColor, drawTicks: false },
            ticks: {
              color: tickColor, font: font, maxTicksLimit: 7, autoSkip: true,
              callback: function (v) {
                return new Date(v).toLocaleDateString(undefined, {
                  month: 'short',
                  day: days <= 91 ? '2-digit' : undefined,
                  year: days > 182 ? '2-digit' : undefined,
                  timeZone: 'UTC'
                });
              }
            }
          },
          y: {
            grid: { color: gridColor, drawTicks: false },
            ticks: { color: tickColor, font: font },
            title: { display: true, text: 'bps', color: tickColor, font: font }
          }
        },
        plugins: {
          legend: {
            display: datasets.length > 1,
            position: 'bottom',
            labels: {
              color: tickColor, font: font, boxWidth: 8, boxHeight: 8,
              usePointStyle: true, pointStyle: 'circle', padding: 16
            }
          },
          tooltip: {
            backgroundColor: dark ? '#121a27' : '#ffffff',
            borderColor: dark ? '#1e2a3c' : 'rgba(0,0,0,0.12)',
            borderWidth: 1,
            titleColor: tickColor,
            bodyColor: dark ? '#dce3ed' : '#1a1a1a',
            titleFont: font,
            bodyFont: { family: 'inherit', size: 13 },
            padding: 10,
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            callbacks: {
              title: function (items) { return fmtDate(items[0].parsed.x); },
              label: function (item) {
                return ' ' + item.dataset.label + '  ' + Math.round(item.parsed.y) + ' bps';
              }
            }
          }
        }
      }
    });
  }

  function boot(root) {
    var node = root.querySelector('.credit-tape-data');
    if (!node) return;

    var cfg;
    try {
      cfg = JSON.parse(node.textContent);
    } catch (e) {
      return;
    }
    if (!cfg.series || !cfg.series.length) return;

    renderCards(root, cfg);
    renderChart(root, cfg);

    var latest = cfg.series.reduce(function (a, s) {
      return s.latestDate > a ? s.latestDate : a;
    }, '');
    var stamp = root.querySelector('.credit-tape-stamp');
    if (stamp && latest) {
      stamp.textContent = 'Close of ' + fmtDate(Date.parse(latest + 'T00:00:00Z')) +
        ' · ICE BofA option-adjusted spreads via FRED';
    }
  }

  function init() {
    document.querySelectorAll('.credit-tape').forEach(boot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
