// Live progress polling for the "My Campaigns" progress page (V6 stepper).
function watchProgress(clickId) {
  const box = document.getElementById('timeline');
  const statusEl = document.getElementById('convStatus');
  if (!box) return;
  async function tick() {
    try {
      const r = await fetch('/api/my/progress/' + encodeURIComponent(clickId));
      if (!r.ok) return;
      const d = await r.json();
      if (statusEl) statusEl.textContent = d.conv_status === 'none' ? 'started' : d.conv_status;
      var cd = document.getElementById('creditDate');
      if (cd && d.expected_credit_date) cd.textContent = d.expected_credit_date;
      box.innerHTML = '<ol class="stepper">' + d.stages.map(function (label, i) {
        var done = i <= d.stage && d.conv_status !== 'rejected';
        var bad = d.conv_status === 'rejected' && i === 5;
        var cls = bad ? 'bad' : done ? 'done' : (i === d.stage + 1 ? 'current' : '');
        var inner = bad ? '✕' : done ? '✓' : (i + 1);
        return '<li class="' + cls + '"><span class="sdot">' + inner + '</span><span class="slbl">' + label + (bad ? ' — Rejected by partner' : '') + '</span></li>';
      }).join('') + '</ol>';
      if (d.stage >= 6 || d.conv_status === 'rejected') clearInterval(timer);
    } catch (e) { /* keep trying */ }
  }
  const timer = setInterval(tick, 4000);
  tick();
}
