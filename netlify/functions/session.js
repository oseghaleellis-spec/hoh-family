// HOH Family – records which device signed in, with IP address and approximate location.
const admin = require("firebase-admin");
function app() { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }); return admin; }
const reply = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(500, { error: "FIREBASE_SERVICE_ACCOUNT is not set" });
  const a = app();
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let caller;
  try { caller = await a.auth().verifyIdToken(String(h.authorization || "").replace(/^Bearer\s+/i, "")); } catch (e) { return reply(401, { error: "Not signed in" }); }
  let p = {}; try { p = JSON.parse(event.body || "{}"); } catch (e) {}
  const deviceId = String(p.deviceId || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  if (!deviceId) return reply(400, { error: "No device id" });
  const ip = String(h["x-nf-client-connection-ip"] || (h["x-forwarded-for"] || "").split(",")[0] || "").trim().slice(0, 60);
  let city = "", country = "";
  try { const g = JSON.parse(Buffer.from(h["x-nf-geo"] || "", "base64").toString("utf8") || "{}"); city = g.city || ""; country = (g.country && (g.country.name || g.country.code)) || ""; } catch (e) {}
  if (!country) country = h["x-country"] || "";
  const db = a.firestore(); const ref = db.doc(`sessions/${caller.uid}_${deviceId}`); const now = new Date().toISOString();
  const snap = await ref.get(); const old = snap.exists ? snap.data() : {};
  await ref.set({ uid: caller.uid, deviceId, label: String(p.label || "").slice(0, 80), ua: String(h["user-agent"] || "").slice(0, 200), ip, city, country, first: old.first || now, last: now,
    count: (old.count || 0) + 1, trusted: !!old.trusted, revoked: !!old.revoked && !p.reset, ips: admin.firestore.FieldValue.arrayUnion(ip || "unknown") }, { merge: true });
  return reply(200, { ok: true, ip, city, country });
};
