/** The dashboard single page — inline HTML/CSS/JS, no build step. Polls /api on load and opens an
 *  SSE stream to /events for live updates. Kept deliberately small and dependency-free. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MemWise</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { padding: 14px 20px; border-bottom: 1px solid #21262d; display: flex;
           gap: 24px; align-items: baseline; position: sticky; top: 0; background: #0d1117; }
  header h1 { margin: 0; font-size: 16px; color: #58a6ff; }
  .stat { color: #8b949e; } .stat b { color: #c9d1d9; }
  main { padding: 16px 20px; max-width: 1100px; }
  .card { border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px;
          background: #11161d; }
  .card .sig { color: #8b949e; font-size: 12px; }
  .card .prompt { color: #e6edf3; margin: 4px 0 8px; font-weight: 600; }
  .card .text { white-space: pre-wrap; color: #adbac7; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px;
           margin-left: 6px; }
  .badge.enriched { background: #1f6feb33; color: #79c0ff; }
  .badge.raw { background: #6e768166; color: #adbac7; }
  .meta { margin-top: 8px; color: #6e7681; font-size: 12px; }
  .feed { color: #6e7681; font-size: 12px; border-top: 1px dashed #21262d; padding-top: 6px;
          margin-top: 8px; }
  .feed .line { padding: 1px 0; }
  .empty { color: #6e7681; padding: 40px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>MemWise</h1>
  <span class="stat"><b id="s-messages">0</b> messages</span>
  <span class="stat">avg embed <b id="s-embed">–</b> ms</span>
  <span class="stat">db <b id="s-db">–</b></span>
  <span class="stat" id="s-live" style="margin-left:auto;color:#3fb950">● live</span>
</header>
<main>
  <div id="cards"></div>
  <div id="feed" class="feed"></div>
</main>
<script>
const fmtBytes = b => b > 1e6 ? (b/1e6).toFixed(1)+' MB' : (b/1e3).toFixed(0)+' KB';
const esc = s => (s||'').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function renderCard(m) {
  return '<div class="card"><div class="sig">'+esc(m.sig.slice(0,12))+' · '+
    new Date(m.ts).toLocaleString()+'<span class="badge '+(m.enriched?'enriched':'raw')+'">'+
    (m.enriched?'enriched':'raw')+'</span></div>'+
    '<div class="prompt">'+esc(m.promptText)+'</div>'+
    '<div class="text">'+esc(m.text)+'</div></div>';
}
async function loadStats() {
  const s = await fetch('/api/stats').then(r=>r.json());
  document.getElementById('s-messages').textContent = s.messages;
  document.getElementById('s-embed').textContent = s.avgEmbedMs ?? '–';
  document.getElementById('s-db').textContent = fmtBytes(s.dbSizeBytes||0);
}
async function loadRecent() {
  const rows = await fetch('/api/recent').then(r=>r.json());
  const el = document.getElementById('cards');
  el.innerHTML = rows.length ? rows.map(renderCard).join('') :
    '<div class="empty">No memories yet — work a turn in an agent, then refresh.</div>';
}
function startSSE() {
  const feed = document.getElementById('feed');
  const es = new EventSource('/events');
  es.onmessage = ev => {
    const e = JSON.parse(ev.data);
    const line = document.createElement('div');
    line.className = 'line';
    line.textContent = '['+e.kind+'] '+JSON.stringify(e.payload);
    feed.prepend(line);
    while (feed.childNodes.length > 40) feed.removeChild(feed.lastChild);
    if (e.kind === 'message') { loadRecent(); loadStats(); }
  };
  es.onerror = () => { document.getElementById('s-live').style.color = '#f85149'; };
}
loadStats(); loadRecent(); startSSE();
setInterval(loadStats, 5000);
</script>
</body>
</html>`
