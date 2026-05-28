// =============================================================
//   HOOPS LIFF — LINE 籃球約團投票（網頁版）
// =============================================================
//  架構：
//   - 群組打「開團」→ 機器人在資料庫建立投票 → 回「前往投票」卡片
//   - 點卡片 → 開 LIFF 網頁 → 勾選時段 → 送出 → 寫入資料庫
//   - 送出後 → 機器人推送最新統計到群組
//   - 「誰沒投」：發起人開團時可附應到名單，網頁顯示已投/未投
//   - 發起人打「結束」→ 鎖定並公布
//
//  需要的環境變數（Render）：
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
//   LIFF_ID, SUPABASE_URL, SUPABASE_KEY
// =============================================================

const express = require("express");
const crypto = require("crypto");
const https = require("https");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LIFF_ID = process.env.LIFF_ID || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// =============================================================
//  LINE API
// =============================================================
function lineApi(method, path, payload, cb) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: "api.line.me",
    path,
    method,
    headers: { Authorization: "Bearer " + CHANNEL_TOKEN },
  };
  if (body) {
    options.headers["Content-Type"] = "application/json";
    options.headers["Content-Length"] = Buffer.byteLength(body);
  }
  const req = https.request(options, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      if (res.statusCode >= 300) console.error("LINE API error:", method, path, res.statusCode, d);
      if (cb) cb(res.statusCode, d);
    });
  });
  req.on("error", (e) => console.error("LINE API req error:", e));
  if (body) req.write(body);
  req.end();
}
const reply = (replyToken, messages) => lineApi("POST", "/v2/bot/message/reply", { replyToken, messages });
const pushTo = (to, messages) => lineApi("POST", "/v2/bot/message/push", { to, messages });
const txt = (text) => ({ type: "text", text });

function resolveName(source, cb) {
  const uid = source.userId;
  if (!uid) return cb("某人");
  let path;
  if (source.type === "group") path = "/v2/bot/group/" + source.groupId + "/member/" + uid;
  else if (source.type === "room") path = "/v2/bot/room/" + source.roomId + "/member/" + uid;
  else path = "/v2/bot/profile/" + uid;
  lineApi("GET", path, null, (code, d) => {
    let name = "成員" + uid.slice(-4);
    try { const j = JSON.parse(d); if (j.displayName) name = j.displayName; } catch (e) {}
    cb(name);
  });
}

// =============================================================
//  投票卡片（含「前往投票」按鈕，開 LIFF）
// =============================================================
function buildEntryFlex(poll, counts) {
  const liffUrl = "https://liff.line.me/" + LIFF_ID + "?poll=" + poll.id;
  const slotLines = (poll.slots || []).map((s) => ({
    type: "box", layout: "horizontal",
    contents: [
      { type: "text", text: s.label, size: "sm", color: "#dddddd", flex: 5, wrap: true },
      { type: "text", text: (counts[s.id] || 0) + " 人", size: "sm", color: "#ffb347", flex: 2, align: "end" },
    ],
  }));
  return {
    type: "flex",
    altText: poll.title + " 開始投票",
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: poll.title + (poll.locked ? "（已結束）" : ""), weight: "bold", size: "lg", color: "#ffffff", wrap: true },
          { type: "separator", color: "#333333" },
          ...slotLines,
        ],
      },
      footer: poll.locked ? undefined : {
        type: "box", layout: "vertical",
        contents: [{
          type: "button", style: "primary", color: "#ff6a2b",
          action: { type: "uri", label: "前往投票 / 看誰投了", uri: liffUrl },
        }],
      },
      styles: { body: { backgroundColor: "#181b22" }, footer: { backgroundColor: "#181b22" } },
    },
  };
}

// 對齊好讀的結果文字（總人頭、每人括號標數量，👑 最多人放最後）
function buildResultText(poll, votersBySlot, finalize) {
  const slots = poll.slots.map((s) => {
    const vs = votersBySlot[s.id] || [];
    const total = vs.reduce((sum, v) => sum + (v.count || 1), 0);
    return { ...s, voters: vs, total };
  });
  const sorted = slots.slice().sort((a, b) => b.total - a.total);

  let t = (finalize ? "📢 投票結束！\n" : "") + poll.title + "\n";
  t += "━━━━━━━━━━\n";
  sorted.forEach((s) => {
    t += "▸ " + s.label + "　" + s.total + " 人\n";
    if (s.voters.length) {
      s.voters.forEach((v, idx) => {
        const extra = v.count > 1 ? "（" + v.count + "）" : "";
        t += "　" + (idx + 1) + ". " + v.name + extra + "\n";
      });
    }
    t += "\n";
  });
  if (sorted.every((s) => s.total === 0)) t += "（還沒有人投票）\n\n";
  if (finalize && sorted[0] && sorted[0].total > 0)
    t += "👑最多人：\n" + sorted[0].label + "（" + sorted[0].total + " 人）";
  return t.trim();
}

// 取得某 poll 的票數統計（加總人頭）
async function getCounts(pollId) {
  const { data } = await supabase.from("votes").select("slot_id, count").eq("poll_id", pollId);
  const counts = {};
  (data || []).forEach((v) => { counts[v.slot_id] = (counts[v.slot_id] || 0) + (v.count || 1); });
  return counts;
}
async function getVotersBySlot(pollId) {
  const { data } = await supabase.from("votes").select("slot_id, name, count").eq("poll_id", pollId);
  const m = {};
  (data || []).forEach((v) => { (m[v.slot_id] = m[v.slot_id] || []).push({ name: v.name, count: v.count || 1 }); });
  return m;
}

// =============================================================
//  解析時段：每行一個「時間 地點」
// =============================================================
function parseSlots(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && /\d/.test(l));
}

// =============================================================
//  Webhook
// =============================================================
app.use("/webhook", express.raw({ type: "*/*" }));
app.post("/webhook", (req, res) => {
  const signature = req.headers["x-line-signature"];
  const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.body).digest("base64");
  if (signature !== hash) return res.status(401).send("bad signature");
  res.status(200).end();
  let payload;
  try { payload = JSON.parse(req.body.toString("utf8")); } catch (e) { return; }
  (payload.events || []).forEach(handleEvent);
});

const gidOf = (s) => s.groupId || s.roomId || s.userId;

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;
  const source = event.source || {};
  const gid = gidOf(source);
  const uid = source.userId || "anon";
  const raw = event.message.text.trim();
  const firstLine = raw.split("\n")[0].trim();
  const cmd = firstLine.replace(/^\//, "");

  // 說明
  if (cmd === "說明" || cmd === "help" || cmd === "幫助") {
    return reply(event.replyToken, [txt(
      "📋 約團投票用法：\n\n【開團】可一次貼多個時段地點：\n開團 （請輸入開團名稱）\n5/31 18:00-20:00 台北\n6/7 16:00-18:00 桃園\n\n【投票】點卡片「前往投票」按鈕，在網頁勾選後送出\n【結果】看目前票數名單\n【結束】發起人專用，鎖定公布\n【關團】清掉重來"
    )]);
  }

  // 開團（可同時多時段；可選擇加應到名單）
  if (cmd.startsWith("開團")) {
    const title = firstLine.replace(/^\/?開團/, "").trim();
    const slotLabels = parseSlots(raw.split("\n").slice(1).join("\n"));

  // 只打「開團」兩字（沒帶名稱、沒帶時段）→ 只回引導，先不建團
  if (!title && slotLabels.length === 0) {
  return resolveName(source, (name) =>
    reply(event.replyToken, [txt(
      "✅ 發起人：" + name + "\n" +
      "請複製以下格式、填好後送出\n" +
      "每行一個時段格式為「日期 時間 地點」:\n\n" +  // 這裡用了兩個 \n 來製造空行
      "開團（輸入開團名稱）\n" +
      "5/31 18:00-20:00 台北\n" +
      "6/7 16:00-18:00 桃園"
    )])
  );
}

    resolveName(source, async (name) => {
      const slots = slotLabels.map((label, i) => ({ id: "s" + i, label }));
      // 關掉同群組舊的未結束投票
      await supabase.from("polls").update({ locked: true }).eq("group_id", gid).eq("locked", false);
      const { data, error } = await supabase.from("polls").insert({
        group_id: gid, title: title || "約團投票", owner_id: uid, owner_name: name,
        slots, locked: false,
      }).select().single();
      if (error) { console.error(error); return reply(event.replyToken, [txt("開團失敗，請稍後再試")]); }
      const msgs = [txt("✅ 已開團：" + (title || "約團投票") + "發起人：" + name +
        (slots.length ? "" : "\n\n還沒加時段，請補上：\n5/31 18:00-20:00 台北\n6/7 16:00-18:00 桃園"))];
      if (slots.length) msgs.push(buildEntryFlex(data, {}));
      reply(event.replyToken, msgs);
    });
    return;
  }

  // 取得目前群組進行中的投票
  const { data: poll } = await supabase.from("polls")
    .select("*").eq("group_id", gid).eq("locked", false)
    .order("created_at", { ascending: false }).limit(1).single();

  // 加時段
  if (cmd.startsWith("加時段")) {
    if (!poll) return reply(event.replyToken, [txt("還沒開團，先打「開團標題」")]);
    const inline = firstLine.replace(/^\/?加時段/, "").trim();
    const labels = [];
    if (inline && /\d/.test(inline)) labels.push(inline);
    labels.push(...parseSlots(raw.split("\n").slice(1).join("\n")));
    if (!labels.length) return reply(event.replyToken, [txt("用法（每行一個）：\n加時段\n5/31 18:00-20:00 台北\n6/7 16:00-18:00 桃園")]);
    const base = poll.slots.length;
    const newSlots = poll.slots.concat(labels.map((label, i) => ({ id: "s" + (base + i), label })));
    await supabase.from("polls").update({ slots: newSlots }).eq("id", poll.id);
    const counts = await getCounts(poll.id);
    return reply(event.replyToken, [txt("已加入 " + labels.length + " 個時段"), buildEntryFlex({ ...poll, slots: newSlots }, counts)]);
  }

  // 結果
  if (cmd === "結果" || cmd === "票數") {
    if (!poll) return reply(event.replyToken, [txt("這個群組還沒開團")]);
    const vbs = await getVotersBySlot(poll.id);
    const counts = await getCounts(poll.id);
    return reply(event.replyToken, [buildEntryFlex(poll, counts), txt(buildResultText(poll, vbs, false))]);
  }

  // 結束（限發起人）
  if (cmd === "結束" || cmd === "定案") {
    if (!poll) return reply(event.replyToken, [txt("這個群組還沒開團")]);
    if (poll.owner_id !== uid) return reply(event.replyToken, [txt("只有發起人（" + poll.owner_name + "）可以結束投票")]);
    await supabase.from("polls").update({ locked: true }).eq("id", poll.id);
    const vbs = await getVotersBySlot(poll.id);
    return reply(event.replyToken, [txt(buildResultText({ ...poll, locked: true }, vbs, true))]);
  }

  // 關團
  if (cmd === "關團" || cmd === "取消") {
    if (!poll) return reply(event.replyToken, [txt("目前沒有進行中的團")]);
    await supabase.from("polls").update({ locked: true }).eq("id", poll.id);
    return reply(event.replyToken, [txt("已關團！想再揪輸入「開團」")]);
  }
}

// =============================================================
//  給網頁用的 API
// =============================================================
app.use(express.json());
app.use(express.static("public"));

// 提供 LIFF ID 給前端
app.get("/api/config", (req, res) => res.json({ liffId: LIFF_ID }));

// 取得某投票的資料 + 目前票數 + 投票者
app.get("/api/poll/:id", async (req, res) => {
  const { data: poll } = await supabase.from("polls").select("*").eq("id", req.params.id).single();
  if (!poll) return res.status(404).json({ error: "not found" });
  const vbs = await getVotersBySlot(poll.id);
  res.json({ poll, votersBySlot: vbs });
});

// 取得「某使用者目前投了哪些、各帶幾人」
app.get("/api/poll/:id/my", async (req, res) => {
  const userId = req.query.userId;
  const { data } = await supabase.from("votes").select("slot_id, count").eq("poll_id", req.params.id).eq("user_id", userId);
  res.json({ selections: (data || []).map((v) => ({ slotId: v.slot_id, count: v.count || 1 })) });
});

// 送出投票（覆蓋該使用者在此 poll 的所有選擇）
app.post("/api/poll/:id/vote", async (req, res) => {
  const pollId = req.params.id;
  const { userId, name, selections } = req.body;
  // selections 格式：[{ slotId, count }]
  const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
  if (!poll) return res.status(404).json({ error: "not found" });
  if (poll.locked) return res.status(403).json({ error: "locked" });

  // 先刪掉這人舊的，再插入新的（一次送出 = 最終選擇）
  await supabase.from("votes").delete().eq("poll_id", pollId).eq("user_id", userId);
  if (selections && selections.length) {
    const rows = selections.map((s) => ({
      poll_id: pollId, user_id: userId, name,
      slot_id: s.slotId, count: Math.max(1, parseInt(s.count) || 1),
    }));
    await supabase.from("votes").insert(rows);
  }

  // 推送最新統計到群組（總人頭）
  const vbs = await getVotersBySlot(pollId);
  const counts = await getCounts(pollId);
  let summary = poll.title + "\n" + name + " 更新了投票\n━━━━━━━━━━\n";
  poll.slots.forEach((s) => { summary += "▸ " + s.label + "　" + (counts[s.id] || 0) + " 人\n"; });
  pushTo(poll.group_id, [
    txt(summary.trim()),
    buildEntryFlex(poll, counts),
  ]);
  res.json({ ok: true, votersBySlot: vbs });
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HOOPS LIFF server listening on " + PORT));
