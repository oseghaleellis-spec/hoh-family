// HOH Family – records which device signed in (IP and approximate location), and signs people out for real.
const admin = require("firebase-admin");
function app() { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }); return admin; }
const reply = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
const clean = (v, n) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, n);
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(500, { error: "FIREBASE_SERVICE_ACCOUNT is not set" });
  if ((event.body || "").length > 4000) return reply(413, { error: "Too large" });
  const a = app();
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let caller;
  try { caller = await a.auth().verifyIdToken(String(h.authorization || "").replace(/^Bearer\s+/i, ""), true); } catch (e) { return reply(401, { error: "Not signed in" }); }
  let p = {}; try { p = JSON.parse(event.body || "{}"); } catch (e) {}
  const db = a.firestore(); const now = new Date().toISOString();

  // ---- sign a person out everywhere (themselves, or anyone if the caller is an admin) ----
  if (p.action === "revoke") {
    const target = clean(p.uid, 128) || caller.uid;
    if (target !== caller.uid) {
      const m = await db.doc(`members/${caller.uid}`).get();
      const owners = ["oseghaleellis@gmail.com"];
      const isAdmin = (m.exists && (m.data().rid || []).includes("admin")) || (caller.email_verified && owners.includes(String(caller.email || "").toLowerCase()));
      if (!isAdmin) return reply(403, { error: "Only an admin can sign someone else out" });
    }
    await a.auth().revokeRefreshTokens(target);
    const dev = clean(p.deviceId, 40);
    if (dev) await db.doc(`sessions/${target}_${dev}`).set({ revoked: true, revokedBy: caller.uid, revokedAt: now, trusted: false }, { merge: true });
    await db.collection("activity").add({ by: caller.uid, at: now, action: "signed out (server)", coll: "sessions", docId: `${target}_${dev}`, label: "" }).catch(() => {});
    return reply(200, { ok: true });
  }

  // ---- record this device ----
  const deviceId = clean(p.deviceId, 40);
  if (!deviceId) return reply(400, { error: "No device id" });
  const ip = String(h["x-nf-client-connection-ip"] || "").trim().slice(0, 60);
  let city = "", country = "";
  try { const g = JSON.parse(Buffer.from(h["x-nf-geo"] || "", "base64").toString("utf8") || "{}"); city = String(g.city || "").slice(0, 60); country = String((g.country && (g.country.name || g.country.code)) || "").slice(0, 60); } catch (e) {}
  const ref = db.doc(`sessions/${caller.uid}_${deviceId}`);
  const snap = await ref.get(); const old = snap.exists ? snap.data() : {};
  // A revoked device stays revoked until the person signs in again (a sign-in newer than the sign-out)
  const signedInAfter = old.revokedAt && caller.auth_time * 1000 > Date.parse(old.revokedAt);
  await ref.set({ uid: caller.uid, deviceId, label: String(p.label || "").slice(0, 80), ua: String(h["user-agent"] || "").slice(0, 200), ip, city, country, first: old.first || now, last: now,
    count: (old.count || 0) + 1, trusted: !!old.trusted && !old.revoked, revoked: !!old.revoked && !signedInAfter, ips: admin.firestore.FieldValue.arrayUnion(ip || "unknown") }, { merge: true });
  return reply(200, { ok: true, ip, city, country });
};
