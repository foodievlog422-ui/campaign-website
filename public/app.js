// Live progress polling for the "My Campaigns" progress page.
function watchProgress(clickId) {
  const box = document.getElementById('timeline');
  const statusEl = document.getElementById('convStatus');
  if (!box) return;
  async function tick() {
    try {
      const r = await fetch('/api/my/progress/' + encodeURIComponent(clickId));
      if (!r.ok) return;
      const d = await r.json();
      if (statusEl) statusEl.textContent = d.conv_status;
      var cd = document.getElementById('creditDate');
      if (cd && d.expected_credit_date) cd.textContent = d.expected_credit_date;
      box.innerHTML = '<ol class="timeline">' + d.stages.map(function (label, i) {
        var done = i <= d.stage && d.conv_status !== 'rejected';
        return '<li class="' + (done ? 'done' : 'todo') + '"><span class="dot">' + (done ? '✓' : (i + 1)) + '</span><span>' + label + '</span></li>';
      }).join('') + '</ol>';
      if (d.stage >= 6 || d.conv_status === 'rejected') clearInterval(timer);
    } catch (e) { /* keep trying */ }
  }
  const timer = setInterval(tick, 4000);
  tick();
}
