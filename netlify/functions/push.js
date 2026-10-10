// HOH Family – sends phone alerts (Firebase Cloud Messaging).
// Needs one Netlify environment variable: FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON from Firebase.
const admin = require("firebase-admin");
function app() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) });
  return admin;
}
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });
// Limits: ordinary members can alert up to 30 people per message and 150 per hour; leaders, offices and admins more.
const LIMITS = { member: [30, 150], staff: [500, 3000] };
const STAFF_ROLES = ["super-admin", "admin", "group-lead", "pastorate", "secretariat", "key-programs-committee", "media-team", "app-admin-team", "church-administration"];

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(500, { error: "FIREBASE_SERVICE_ACCOUNT is not set in Netlify" });
  if ((event.body || "").length > 60000) return reply(413, { error: "Too large" });
  const a = app();
  const idToken = String(event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
  let caller;
  try { caller = await a.auth().verifyIdToken(idToken, true); } catch (e) { return reply(401, { error: "Not signed in" }); }
  const db = a.firestore();
  const member = await db.doc(`members/${caller.uid}`).get();
  if (!member.exists) return reply(403, { error: "Not an approved member" });
  const m = member.data();
  if (m.suspended) return reply(403, { error: "Access paused" });
  const staff = [...(m.rid || []), ...(m.groups || [])].some((r) => STAFF_ROLES.includes(r));
  const [perMsg, perHour] = LIMITS[staff ? "staff" : "member"];

  let p = {};
  try { p = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Bad request" }); }
  const uids = [...new Set((Array.isArray(p.uids) ? p.uids : []).filter((u) => typeof u === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(u) && u !== caller.uid))];
  if (!uids.length) return reply(200, { sent: 0 });
  if (uids.length > perMsg) return reply(429, { error: `You can alert at most ${perMsg} people at once` });

  // hourly limit per sender (kept in a private counter document only the server can see)
  const hourKey = new Date().toISOString().slice(0, 13);
  const meter = db.doc(`pushmeter/${caller.uid}`);
  const allowed = await db.runTransaction(async (tx) => {
    const s = await tx.get(meter); const d = s.exists ? s.data() : {};
    const used = d.hour === hourKey ? d.count || 0 : 0;
    if (used + uids.length > perHour) return false;
    tx.set(meter, { hour: hourKey, count: used + uids.length, at: new Date().toISOString() });
    return true;
  });
  if (!allowed) return reply(429, { error: "Too many alerts this hour – please try again later" });

  // the real sender's name is always shown, so nobody can pretend to be someone else
  const prof = await db.doc(`profiles/${caller.uid}`).get();
  const sender = String((prof.exists && prof.data().name) || "A member").replace(/[\r\n]+/g, " ").slice(0, 60);
  const body = String(p.body || "").slice(0, 220);
  const data = { title: String(p.title || "HOH Family").replace(/[\r\n]+/g, " ").slice(0, 120), body: `${body}${body ? "\n" : ""}— ${sender}`, page: String(p.page || "alerts").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 80) };

  const snaps = await db.getAll(...uids.map((u) => db.doc(`pushTokens/${u}`)));
  const owners = new Map();
  for (const s of snaps) if (s.exists) for (const t of s.data().tokens || []) owners.set(t, s.id);
  const tokens = [...owners.keys()];
  if (!tokens.length) return reply(200, { sent: 0 });
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await a.messaging().sendEachForMulticast({ tokens: batch, data, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
    sent += res.successCount;
    const dead = [];
    res.responses.forEach((r, k) => { const c = r.error && r.error.code; if (c === "messaging/registration-token-not-registered" || c === "messaging/invalid-registration-token") dead.push(batch[k]); });
    await Promise.all(dead.map((t) => db.doc(`pushTokens/${owners.get(t)}`).set({ tokens: admin.firestore.FieldValue.arrayRemove(t) }, { merge: true }).catch(() => {})));
  }
  return reply(200, { sent });
};
