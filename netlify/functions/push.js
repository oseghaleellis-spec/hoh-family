// HOH Family – sends phone alerts (Firebase Cloud Messaging).
// Needs one Netlify environment variable: FIREBASE_SERVICE_ACCOUNT = the whole service-account JSON from Firebase.
const admin = require("firebase-admin");

function app() {
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin;
}
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(500, { error: "FIREBASE_SERVICE_ACCOUNT is not set in Netlify" });
  const a = app();
  // 1) only signed-in, approved members of HOH Family may send
  const idToken = String(event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "");
  let caller;
  try { caller = await a.auth().verifyIdToken(idToken); } catch (e) { return reply(401, { error: "Not signed in" }); }
  const db = a.firestore();
  const member = await db.doc(`members/${caller.uid}`).get();
  if (!member.exists) return reply(403, { error: "Not an approved member" });
  // 2) read the request
  let p = {};
  try { p = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "Bad request" }); }
  const uids = [...new Set((Array.isArray(p.uids) ? p.uids : []).filter((u) => typeof u === "string" && u && u !== caller.uid))].slice(0, 500);
  if (!uids.length) return reply(200, { sent: 0 });
  const data = { title: String(p.title || "HOH Family").slice(0, 120), body: String(p.body || "").slice(0, 240), page: String(p.page || "alerts").slice(0, 80) };
  // 3) collect the phones (tokens) of the people being alerted
  const snaps = await db.getAll(...uids.map((u) => db.doc(`pushTokens/${u}`)));
  const owners = new Map();
  for (const s of snaps) if (s.exists) for (const t of s.data().tokens || []) owners.set(t, s.id);
  const tokens = [...owners.keys()];
  if (!tokens.length) return reply(200, { sent: 0 });
  // 4) send, and clean up phones that no longer accept alerts
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
