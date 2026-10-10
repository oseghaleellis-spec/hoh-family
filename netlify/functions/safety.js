// HOH Family – every morning: (1) counts finance entries worth a look in each group, without anyone opening the records;
// (2) reminds people about scheduled report shares; (3) closes temporary access that has run out.
const admin = require("firebase-admin");
function app() { if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}")) }); return admin; }
const lagosDate = (plusDays) => new Date(Date.now() + 60 * 60 * 1000 + plusDays * 864e5).toISOString().slice(0, 10);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const KIND = { finance: "Finance summary", dues: "Dues summary", roster: "Roster summary", log: "Minutes & activity summary", inventory: "Inventory summary", requests: "Requests summary", office: "Office summary" };

async function tell(a, db, uids, title, body, page) {
  const ids = [...new Set(uids.filter(Boolean))]; if (!ids.length) return;
  const at = new Date().toISOString();
  await Promise.all(ids.map((u) => db.collection(`inbox/${u}/items`).add({ title, body, page, at, read: false, from: "system" }).catch(() => {})));
  try {
    const snaps = await db.getAll(...ids.map((u) => db.doc(`pushTokens/${u}`)));
    const tokens = snaps.flatMap((s) => (s.exists ? s.data().tokens || [] : []));
    for (let i = 0; i < tokens.length; i += 500) await a.messaging().sendEachForMulticast({ tokens: tokens.slice(i, i + 500), data: { title, body, page }, webpush: { headers: { Urgency: "high", TTL: "86400" } } });
  } catch (e) {}
}

exports.handler = async () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return { statusCode: 500, body: "FIREBASE_SERVICE_ACCOUNT is not set" };
  const a = app(); const db = a.firestore(); const now = new Date().toISOString(); const out = [];
  const teams = await db.collection("teams").get();

  // 1. finance checks – counts only
  for (const t of teams.docs) {
    try {
      const fin = await db.collection(`teams/${t.id}/finance`).get();
      const R = fin.docs.map((d) => d.data()); const amts = R.map((r) => Number(r.amount) || 0).filter((x) => x > 0); const md = median(amts);
      let backdated = 0, large = 0;
      for (const r of R) {
        if (r.date && r.at && (Date.parse(String(r.at).slice(0, 10)) - Date.parse(r.date)) / 864e5 > 7) backdated++;
        if (amts.length >= 5 && md && Number(r.amount) >= 50000 && Number(r.amount) > 3 * md) large++;
      }
      await db.doc(`monitor_fin/${t.id}`).set({ name: t.data().name || t.id, backdated, large, total: R.length, at: now });
    } catch (e) {}
  }
  out.push("finance checked");

  // 2. scheduled shares due tomorrow or today
  const today = lagosDate(0), tomorrow = lagosDate(1);
  const plans = await db.collection("shareplans").where("status", "==", "Active").get();
  const tname = Object.fromEntries(teams.docs.map((t) => [t.id, t.data()]));
  for (const p of plans.docs) {
    const d = p.data(); if (!d.next || d.next > tomorrow) continue;
    const key = `${d.next}:${d.next <= today ? "due" : "soon"}`; if (d.remindedFor === key) continue;
    const t = tname[d.g] || {};
    await tell(a, db, [d.by, ...(t.leads || [])], `${KIND[d.kind] || "Report"} due ${d.next <= today ? "today" : "tomorrow"}`, `${t.name || d.g}: open the group's ${d.kind} tab (or the office) and tap “Prepare it” to share it.`, d.kind === "office" ? "mygroups" : `mygroups:${d.g}`);
    await p.ref.set({ remindedFor: key }, { merge: true });
  }
  out.push("share reminders sent");

  // 3. temporary access that has run out
  const bg = await db.collection("breakglass").where("status", "==", "Active").get();
  for (const b of bg.docs) if ((b.data().untilMs || 0) < Date.now()) await b.ref.set({ status: "Ended", endedBy: "time", endedAt: now }, { merge: true });
  out.push("temporary access tidied");
  return { statusCode: 200, body: out.join("; ") };
};
