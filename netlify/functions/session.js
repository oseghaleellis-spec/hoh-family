// HOH Family – records which device signed in (IP and approximate location), signs people out for real,
// and counts failed sign-in attempts (Super Admins are alerted after more than 2 within an hour).
const admin = require("firebase-admin");
const crypto = require("crypto");
function app() { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }); return admin; }
const reply = (c, o) => ({ statusCode: c, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(o) });
const clean = (v, n) => String(v || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, n);
const OWNERS = ["oseghaleellis@gmail.com"];
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function geoOf(h) {
  const ip = String(h["x-nf-client-connection-ip"] || "").trim().slice(0, 60);
  let city = "", country = "";
  try { const g = JSON.parse(Buffer.from(h["x-nf-geo"] || "", "base64").toString("utf8") || "{}"); city = String(g.city || "").slice(0, 60); country = String((g.country && (g.country.name || g.country.code)) || "").slice(0, 60); } catch (e) {}
  return { ip, city, country };
}

// in-app alert + phone alert to every Super Admin (the owner is always one)
async function alertSA(a, db, title, body, page) {
  const ids = new Set();
  try { const st = await db.doc("settings/main").get(); if (st.exists && st.data().ownerUid) ids.add(st.data().ownerUid); } catch (e) {}
  try { const q = await db.collection("members").where("rid", "array-contains", "super-admin").get(); q.forEach((d) => { if (!d.data().suspended) ids.add(d.id); }); } catch (e) {}
  if (!ids.size) return;
  const at = new Date().toISOString();
  await Promise.all([...ids].map((u) => db.collection(`inbox/${u}/items`).add({ title, body, page, at, read: false, from: "system" }).catch(() => {})));
  try {
    const snaps = await db.getAll(...[...ids].map((u) => db.doc(`pushTokens/${u}`)));
    const tokens = []; snaps.forEach((s) => { if (s.exists) tokens.push(...(s.data().tokens || [])); });
    if (tokens.length) await a.messaging().sendEachForMulticast({ tokens: tokens.slice(0, 500), data: { title: String(title).slice(0, 120), body: String(body).slice(0, 220), page }, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
  } catch (e) {}
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "POST only" });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return reply(500, { error: "FIREBASE_SERVICE_ACCOUNT is not set" });
  if ((event.body || "").length > 4000) return reply(413, { error: "Too large" });
  const a = app();
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  let p = {}; try { p = JSON.parse(event.body || "{}"); } catch (e) {}
  const db = a.firestore(); const now = new Date().toISOString();

  // ---- a failed password sign-in (no sign-in token yet, so this part is open but throttled) ----
  if (p.action === "fail") {
    const email = String(p.email || "").toLowerCase().trim().slice(0, 120);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: "Bad email" });
    const { ip, city, country } = geoOf(h);
    const hourKey = now.slice(0, 13);
    const ipRef = db.doc(`loginfails_ip/${sha(ip || "unknown").slice(0, 32)}`);
    const okIp = await db.runTransaction(async (tx) => { const s = await tx.get(ipRef); const d = s.exists ? s.data() : {}; const used = d.hour === hourKey ? d.count || 0 : 0; if (used >= 30) return false; tx.set(ipRef, { hour: hourKey, count: used + 1 }); return true; });
    if (!okIp) return reply(429, { error: "Too many attempts" });
    const ref = db.doc(`loginfails/${sha(email).slice(0, 40)}`);
    const res = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref); const d = s.exists ? s.data() : {};
      const same = d.windowStart && Date.now() - Date.parse(d.windowStart) < 3600e3;
      const count = same ? (d.count || 0) + 1 : 1; const alerted = same ? !!d.alerted : false;
      tx.set(ref, { email, count, windowStart: same ? d.windowStart : now, last: now, total: (d.total || 0) + 1, ip, city, country, code: clean(p.code, 60), alerted: alerted || count > 2, ips: admin.firestore.FieldValue.arrayUnion(ip || "unknown") }, { merge: true });
      return { count, needAlert: count > 2 && !alerted };
    });
    if (res.needAlert) await alertSA(a, db, `⚠ ${res.count} failed sign-in attempts`, `Someone tried to sign in as ${email} ${res.count} times within an hour${city ? ` from ${city}${country ? ", " + country : ""}` : ""}${ip ? ` (IP ${ip})` : ""}.`, "monitor");
    return reply(200, { ok: true });
  }

  let caller;
  try { caller = await a.auth().verifyIdToken(String(h.authorization || "").replace(/^Bearer\s+/i, ""), true); } catch (e) { return reply(401, { error: "Not signed in" }); }

  // ---- sign a person out everywhere (themselves, or anyone if the caller is an admin) ----
  if (p.action === "revoke") {
    const target = clean(p.uid, 128) || caller.uid;
    if (target !== caller.uid) {
      const m = await db.doc(`members/${caller.uid}`).get();
      const md = m.exists ? m.data() : {};
      const isAdmin = (!md.suspended && (md.rid || []).some((r) => r === "admin" || r === "super-admin")) || (caller.email_verified && OWNERS.includes(String(caller.email || "").toLowerCase()));
      if (!isAdmin) return reply(403, { error: "Only an admin can sign someone else out" });
    }
    await a.auth().revokeRefreshTokens(target);
    const dev = clean(p.deviceId, 40);
    if (dev) await db.doc(`sessions/${target}_${dev}`).set({ revoked: true, revokedBy: caller.uid, revokedAt: now, trusted: false }, { merge: true });
    else { const all = await db.collection("sessions").where("uid", "==", target).get(); await Promise.all(all.docs.map((d) => d.ref.set({ revoked: true, revokedBy: caller.uid, revokedAt: now, trusted: false }, { merge: true }))); }
    await db.collection("activity").add({ by: caller.uid, at: now, act: "signed out (server)", coll: "sessions", rid: `${target}_${dev || "all"}`, label: "" }).catch(() => {});
    return reply(200, { ok: true });
  }

  // ---- record this device ----
  const deviceId = clean(p.deviceId, 40);
  if (!deviceId) return reply(400, { error: "No device id" });
  const { ip, city, country } = geoOf(h);
  const ref = db.doc(`sessions/${caller.uid}_${deviceId}`);
  const snap = await ref.get(); const old = snap.exists ? snap.data() : {};
  // A revoked device stays revoked until the person signs in again (a sign-in newer than the sign-out)
  const signedInAfter = old.revokedAt && caller.auth_time * 1000 > Date.parse(old.revokedAt);
  // first time this person signs in from a new country? tell the Super Admins
  if (!snap.exists) {
    try {
      const others = await db.collection("sessions").where("uid", "==", caller.uid).get();
      // "Was this you?" – tell the person whenever their account signs in on a new phone or computer
      if (others.size) {
        const label = String(p.label || "a new device").slice(0, 80);
        const where = [city, country].filter(Boolean).join(", ");
        const title = "New sign-in on your account";
        const body = `${label}${where ? " in " + where : ""}. If this wasn't you, open My Profile → My devices and sign out everywhere, then change your password.`;
        await db.collection(`inbox/${caller.uid}/items`).add({ title, body, page: "profile", at: now, read: false, from: "system" }).catch(() => {});
        try { const t = await db.doc(`pushTokens/${caller.uid}`).get(); const tokens = t.exists ? t.data().tokens || [] : []; if (tokens.length) await a.messaging().sendEachForMulticast({ tokens: tokens.slice(0, 500), data: { title, body, page: "profile" }, webpush: { headers: { Urgency: "high", TTL: "86400" } } }); } catch (e) {}
      }
      const seen = new Set(others.docs.map((d) => d.data().country).filter(Boolean));
      if (country && seen.size && !seen.has(country)) {
        const pr = await db.doc(`profiles/${caller.uid}`).get();
        const name = (pr.exists && pr.data().name) || caller.email || "A member";
        await alertSA(a, db, "⚠ Sign-in from a new country", `${name} signed in from ${city ? city + ", " : ""}${country} for the first time (usually ${[...seen].join(", ")}).`, "monitor");
      }
    } catch (e) {}
  }
  await ref.set({ uid: caller.uid, deviceId, label: String(p.label || "").slice(0, 80), ua: String(h["user-agent"] || "").slice(0, 200), ip, city, country, first: old.first || now, last: now,
    count: (old.count || 0) + 1, trusted: !!old.trusted && !old.revoked, revoked: !!old.revoked && !signedInAfter, ips: admin.firestore.FieldValue.arrayUnion(ip || "unknown") }, { merge: true });
  return reply(200, { ok: true, ip, city, country });
};
