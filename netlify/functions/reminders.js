// HOH Family – every morning, alerts people about programmes happening in 3 days (for those who asked to be reminded).
const admin = require("firebase-admin");
function app() { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }); return admin; }
const lagosDate = (plusDays) => { const d = new Date(Date.now() + 60 * 60 * 1000 + plusDays * 864e5); return d.toISOString().slice(0, 10); };
exports.handler = async () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return { statusCode: 500, body: "FIREBASE_SERVICE_ACCOUNT is not set" };
  const a = app(); const db = a.firestore();
  const target = lagosDate(3);
  const cal = await db.doc("public/calendar").get();
  const items = ((cal.exists && cal.data().items) || []).filter((x) => x.date === target && !["Cancelled", "Not Held", "Postponed", "Suspended"].includes(x.status));
  if (!items.length) return { statusCode: 200, body: "No programmes in 3 days" };
  const [members, profiles, teams] = await Promise.all([db.collection("members").get(), db.collection("profiles").get(), db.collection("teams").get()]);
  const tname = Object.fromEntries(teams.docs.map((t) => [t.id, t.data().name]));
  const prof = Object.fromEntries(profiles.docs.map((p) => [p.id, p.data()]));
  let sent = 0;
  for (const it of items) {
    const aud = it.aud || [];
    const uids = members.docs.filter((m) => {
      const p = prof[m.id] || {}; const pref = p.remind || "chosen";
      if (pref === "off") return false;
      const sees = aud.includes("Everyone") || (m.data().groups || []).some((g) => aud.includes(tname[g]));
      return sees && (pref === "all" || (p.remindPids || []).includes(it.id));
    }).map((m) => m.id);
    if (!uids.length) continue;
    const title = `In 3 days: ${it.prog}`, body = [it.time, it.venue].filter(Boolean).join(" · ") || "Tap to see the details";
    const at = new Date().toISOString();
    await Promise.all(uids.map((u) => db.collection(`inbox/${u}/items`).add({ title, body, page: "calendar", at, read: false, from: "system" }).catch(() => {})));
    const toks = await db.getAll(...uids.map((u) => db.doc(`pushTokens/${u}`)));
    const tokens = toks.flatMap((s) => (s.exists ? s.data().tokens || [] : []));
    for (let i = 0; i < tokens.length; i += 500) {
      const r = await a.messaging().sendEachForMulticast({ tokens: tokens.slice(i, i + 500), data: { title, body, page: "calendar" }, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
      sent += r.successCount;
    }
  }
  return { statusCode: 200, body: `Reminders sent: ${sent}` };
};
