// Sends Capitol Quest play reminders. Run by .github/workflows/remind.yml (GitHub's schedule, plus an
// optional outside pinger that calls workflow_dispatch, because GitHub's own schedule is unreliable).
// Reads reminder settings from Firestore, sends a Web Push to anyone who is due and hasn't played yet today.
import webpush from 'web-push';

const P = process.env.FIREBASE_PROJECT, K = process.env.FIREBASE_API_KEY;
const PUB = process.env.VAPID_PUBLIC_KEY, PRIV = process.env.VAPID_PRIVATE_KEY;
const DRY = process.env.DRY_RUN === '1';
const BASE = process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1';
if (!P || !K || !PUB || !PRIV) { console.log('Missing config or VAPID_PRIVATE_KEY secret; nothing sent.'); process.exit(0); }
webpush.setVapidDetails('https://jaystone9.github.io/capitol-quest/', PUB, PRIV);

const col = `${BASE}/projects/${encodeURIComponent(P)}/databases/(default)/documents/reminders`;
const dec = d => { const o = {}; for (const [k, v] of Object.entries(d.fields || {})) o[k] = v.integerValue != null ? +v.integerValue : v.stringValue ?? null; o.id = d.name.split('/').pop(); return o; };
const NEED = { daily: 1, every2: 2, weekly: 7 };
const MSGS = [
  ['Your daily civics lesson is waiting', 'Five minutes with Ruckus keeps your streak alive.'],
  ['Ruckus is tapping his talons', "You haven't played today. One quick lesson?"],
  ['Question authority. Know how it works.', 'A short lesson is ready when you are.'],
  ['Democracy is a habit', 'Keep yours going with one lesson today.'],
];
const AWAY = ['We miss you at Capitol Quest', 'Pick up right where you left off. One short lesson is all it takes.'];

function localParts(tz) {
  let f; try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
const days = (a, b) => (!a || !b) ? 999 : Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);

export function due(r, now) {
  if (!NEED[r.freq] || !r.endpoint) return false;
  if (r.lastSent === now.date) return false;
  const h = Number.isFinite(r.hour) ? r.hour : 19;
  // GitHub often runs scheduled jobs hours late or skips them, so a run any time from the chosen hour
  // until 11 PM local still sends. Never before the chosen hour, never late at night.
  if (now.hour < h || now.hour >= Math.max(h + 1, 23)) return false;
  const since = days(now.date, r.lastPlayed);
  if (since <= 0) return false;                                  // already played today
  let need = NEED[r.freq];
  if (since >= 14 && need < 7) need = 7;                         // back off to weekly after 2 weeks away
  return since >= need && days(now.date, r.lastSent) >= need;
}

async function list() {
  const out = []; let tok = '';
  do {
    const res = await fetch(`${col}?key=${K}&pageSize=300${tok ? '&pageToken=' + tok : ''}`);
    if (!res.ok) throw new Error('list failed ' + res.status);
    const j = await res.json(); (j.documents || []).forEach(d => out.push(dec(d))); tok = j.nextPageToken || '';
  } while (tok);
  return out;
}

const rs = await list(); let sent = 0;
for (const r of rs) {
  const now = localParts(r.tz || 'America/Los_Angeles');
  if (!due(r, now)) continue;
  const m = days(now.date, r.lastPlayed) >= 7 ? AWAY : MSGS[Math.floor(Math.random() * MSGS.length)];
  if (DRY) { console.log('would send', r.id); sent++; continue; }
  try {
    await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify({ title: m[0], body: m[1] }), { TTL: 6 * 3600, urgency: 'normal' });
    await fetch(`${col}/${encodeURIComponent(r.id)}?key=${K}&updateMask.fieldPaths=lastSent`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { lastSent: { stringValue: now.date } } }) });
    sent++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) await fetch(`${col}/${encodeURIComponent(r.id)}?key=${K}`, { method: 'DELETE' }); // subscription expired
    else console.log('send failed', r.id.slice(0, 6), e.statusCode || '', (e.body || e.message || '').toString().slice(0, 300));
  }
}
console.log(`checked ${rs.length}, sent ${sent}`);
