// =============================================================
//  🏀 HOOPS — LINE 籃球約團投票機器人 v2
// =============================================================
//  喚醒指令（在群組直接打字，不用斜線）：
//    開團 標題 | 場地        例: 開團 週日籃球 | 中山運動中心
//      （也可開團同時一次貼多個時段，每行一個，例如：
//        開團 週日籃球 | 中山
//        5/31 18:00-20:00
//        6/7 16:00-18:00 ）
//    加時段                  一次可多行，每行一個時段
//    結果                    看目前票數與完整名單
//    結束                    （限發起人）鎖定投票並公布結果
//    關團 / 取消             清掉本團
//    說明 / help             看用法
//
//  投票：點卡片上的時段按鈕即可（可複選，再點一次取消）。
//  有人投票後，機器人會主動推送「誰投了 + 各時段人數 + 已投名單」。
// =============================================================

const express = require("express");
const crypto = require("crypto");
const https = require("https");

const app = express();
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// ---- 記憶體儲存（重啟會清空）----
// polls[gid] = { title, venue, ownerId, locked, slots:[{id,label,voters:[{id,name}]}] }
const polls = {};
// 抓到的 LINE 名稱快取： userId -> name
const nameCache = {};
// 防洗版：gid -> 最近一次 push 的計時器
const pushTimers = {};

// =============================================================
//  LINE API 工具
// =============================================================
function lineApi(method, path, payload, cb) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: "api.line.me",
    path,
    method,
    headers: {
      Authorization: "Bearer " + CHANNEL_TOKEN,
    },
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
  req.on("error", (e) => console.error("LINE API request error:", e));
  if (body) req.write(body);
  req.end();
}

function reply(replyToken, messages) {
  lineApi("POST", "/v2/bot/message/reply", { replyToken, messages });
}
function pushTo(to, messages) {
  lineApi("POST", "/v2/bot/message/push", { to, messages });
}
function txt(text) {
  return { type: "text", text };
}

// 抓 LINE 顯示名稱（群組成員 / 一對一），抓到就快取
function resolveName(source, cb) {
  const uid = source.userId;
  if (!uid) return cb("某人");
  if (nameCache[uid]) return cb(nameCache[uid]);

  let path;
  if (source.type === "group") path = "/v2/bot/group/" + source.groupId + "/member/" + uid;
  else if (source.type === "room") path = "/v2/bot/room/" + source.roomId + "/member/" + uid;
  else path = "/v2/bot/profile/" + uid;

  lineApi("GET", path, null, (code, d) => {
    let name = "球友" + uid.slice(-4);
    try {
      const j = JSON.parse(d);
      if (j.displayName) name = j.displayName;
    } catch (e) {}
    nameCache[uid] = name;
    cb(name);
  });
}

// =============================================================
//  畫面組裝
// =============================================================
function buildVoteFlex(poll) {
  const rows = poll.slots.map((s) => ({
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      {
        type: "button",
        style: "primary",
        color: poll.locked ? "#555555" : "#ff6a2b",
        height: "sm",
        action: poll.locked
          ? { type: "postback", label: "已結束", data: "noop" }
          : { type: "postback", label: s.label, data: "vote:" + s.id, displayText: "我投 " + s.label },
        flex: 5,
      },
      {
        type: "text",
        text: String(s.voters.length) + " 人",
        size: "sm",
        color: "#ffb347",
        gravity: "center",
        align: "end",
        flex: 2,
      },
    ],
  }));

  return {
    type: "flex",
    altText: "🏀 " + poll.title + " 投票",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "🏀 " + poll.title + (poll.locked ? "（已結束）" : ""), weight: "bold", size: "lg", color: "#ffffff", wrap: true },
          poll.venue ? { type: "text", text: "📍 " + poll.venue, size: "sm", color: "#aaaaaa", wrap: true } : { type: "filler" },
          { type: "separator", color: "#333333" },
          { type: "text", text: poll.locked ? "投票已結束" : "點時段按鈕投票（可複選，再點一次取消）", size: "xs", color: "#888888", wrap: true },
          ...rows,
        ],
      },
      styles: { body: { backgroundColor: "#181b22" } },
    },
  };
}

// 精簡推送：誰投了 + 一行各時段人數
function buildPushText(poll, who, slotLabel) {
  const line = poll.slots.map((s) => s.label.split(" ")[0] + "→" + s.voters.length).join("｜");
  return "🏀 " + poll.title + "\n" + who + " 投了 " + slotLabel + "\n目前：" + line;
}

// 完整名單（打「結果」或「結束」時）
function buildResultText(poll, finalize) {
  const sorted = poll.slots.slice().sort((a, b) => b.voters.length - a.voters.length);
  let t = (finalize ? "📢 投票結束！\n" : "") + "🏀 " + poll.title + "\n";
  if (poll.venue) t += "📍 " + poll.venue + "\n";
  t += "\n";
  sorted.forEach((s, i) => {
    const crown = i === 0 && s.voters.length > 0 ? "👑 " : "　";
    t += crown + s.label + "　" + s.voters.length + "人\n";
    if (s.voters.length) t += "　　" + s.voters.map((v) => v.name).join("、") + "\n";
  });
  if (sorted.every((s) => s.voters.length === 0)) t += "（還沒有人投票）\n";
  if (finalize && sorted[0] && sorted[0].voters.length > 0) {
    t += "\n✅ 最多人：" + sorted[0].label + "（" + sorted[0].voters.length + " 人）";
  }
  return t.trim();
}

// 防洗版：0.8 秒內多次投票只推一次最新狀態
function schedulePush(gid, poll) {
  if (pushTimers[gid]) clearTimeout(pushTimers[gid]);
  const pending = poll._pending;
  poll._pending = null;
  pushTimers[gid] = setTimeout(() => {
    if (pending) pushTo(gid, [buildVoteFlex(poll), txt(buildPushText(poll, pending.who, pending.label))]);
    pushTimers[gid] = null;
  }, 800);
}

// =============================================================
//  解析時段：把多行文字拆成時段陣列
// =============================================================
function parseSlots(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && /\d/.test(l)); // 含數字的行視為時段
}

function addSlots(poll, labels) {
  labels.forEach((label) => {
    poll.slots.push({ id: "s" + poll.slots.length + Date.now().toString(36).slice(-3), label, voters: [] });
  });
}

// =============================================================
//  Webhook
// =============================================================
app.use("/webhook", express.raw({ type: "*/*" }));

app.post("/webhook", (req, res) => {
  const signature = req.headers["x-line-signature"];
  const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.body).digest("base64");
  if (signature !== hash) {
    console.error("簽章驗證失敗");
    return res.status(401).send("bad signature");
  }
  res.status(200).end();
  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    return;
  }
  (payload.events || []).forEach(handleEvent);
});

function gidOf(source) {
  return source.groupId || source.roomId || source.userId;
}

function handleEvent(event) {
  const source = event.source || {};
  const gid = gidOf(source);
  const uid = source.userId || "anon";

  // ---------- 點按鈕投票 ----------
  if (event.type === "postback") {
    const data = event.postback.data || "";
    if (data === "noop") return;
    if (data.startsWith("vote:")) {
      const poll = polls[gid];
      if (!poll) return reply(event.replyToken, [txt("這個群組還沒開團，打「開團 標題 | 場地」開始")]);
      if (poll.locked) return reply(event.replyToken, [txt("投票已經結束囉")]);
      const slot = poll.slots.find((s) => s.id === data.slice(5));
      if (!slot) return;
      resolveName(source, (name) => {
        const idx = slot.voters.findIndex((v) => v.id === uid);
        if (idx > -1) slot.voters.splice(idx, 1);
        else slot.voters.push({ id: uid, name });
        // 安排推送（誰投了 + 最新票數），含防洗版
        poll._pending = { who: name, label: slot.label };
        schedulePush(gid, poll);
      });
      return;
    }
    return;
  }

  // ---------- 文字指令（自然詞，不用斜線）----------
  if (event.type === "message" && event.message.type === "text") {
    const raw = event.message.text.trim();
    const firstLine = raw.split("\n")[0].trim();
    const cmd = firstLine.replace(/^\//, ""); // 容許有沒有斜線都行

    // 說明
    if (cmd === "說明" || cmd === "help" || cmd === "幫助") {
      return reply(event.replyToken, [
        txt(
          "🏀 約團投票用法（直接打字，不用斜線）：\n\n" +
            "【開團】可一次貼多個時段：\n" +
            "開團 週日籃球 | 中山運動中心\n" +
            "5/31 18:00-20:00\n" +
            "6/7 16:00-18:00\n\n" +
            "【加時段】開團後再補，一次可多行\n" +
            "【投票】點卡片上的按鈕（可複選）\n" +
            "【結果】看目前票數和名單\n" +
            "【結束】發起人專用，鎖定並公布\n" +
            "【關團】清掉重來"
        ),
      ]);
    }

    // 開團（可同時帶多時段）
    if (cmd.startsWith("開團")) {
      const headRest = firstLine.replace(/^\/?開團/, "").trim();
      let title = headRest, venue = "";
      if (headRest.includes("|")) {
        const p = headRest.split("|");
        title = p[0].trim();
        venue = p[1].trim();
      }
      resolveName(source, (name) => {
        polls[gid] = { title: title || "籃球揪團", venue, ownerId: uid, ownerName: name, locked: false, slots: [] };
        // 第一行以外、含數字的行 → 當作時段一起加
        const extraSlots = parseSlots(raw.split("\n").slice(1).join("\n"));
        if (extraSlots.length) addSlots(polls[gid], extraSlots);
        const msgs = [
          txt(
            "✅ 已開團：" + (title || "籃球揪團") + (venue ? "（" + venue + "）" : "") +
              "\n發起人：" + name +
              (extraSlots.length ? "" : "\n\n接著打「加時段」加可預約時段，一次可貼多行：\n加時段\n5/31 18:00-20:00\n6/7 16:00-18:00")
          ),
        ];
        if (extraSlots.length) msgs.push(buildVoteFlex(polls[gid]));
        reply(event.replyToken, msgs);
      });
      return;
    }

    // 加時段（一次可多行）
    if (cmd.startsWith("加時段")) {
      const poll = polls[gid];
      if (!poll) return reply(event.replyToken, [txt("還沒開團，先打「開團 標題 | 場地」")]);
      // 第一行去掉「加時段」後若有內容也算一個，加上後續各行
      const inline = firstLine.replace(/^\/?加時段/, "").trim();
      const labels = [];
      if (inline && /\d/.test(inline)) labels.push(inline);
      labels.push(...parseSlots(raw.split("\n").slice(1).join("\n")));
      if (labels.length === 0) return reply(event.replyToken, [txt("用法（可多行）：\n加時段\n5/31 18:00-20:00\n6/7 16:00-18:00")]);
      addSlots(poll, labels);
      return reply(event.replyToken, [txt("已加入 " + labels.length + " 個時段：\n" + labels.join("\n")), buildVoteFlex(poll)]);
    }

    // 結果
    if (cmd === "結果" || cmd === "票數") {
      const poll = polls[gid];
      if (!poll) return reply(event.replyToken, [txt("這個群組還沒開團")]);
      return reply(event.replyToken, [buildVoteFlex(poll), txt(buildResultText(poll, false))]);
    }

    // 結束（限發起人）
    if (cmd === "結束" || cmd === "定案") {
      const poll = polls[gid];
      if (!poll) return reply(event.replyToken, [txt("這個群組還沒開團")]);
      if (poll.ownerId !== uid) {
        return resolveName(source, () =>
          reply(event.replyToken, [txt("只有發起人（" + poll.ownerName + "）可以結束投票喔")])
        );
      }
      poll.locked = true;
      return reply(event.replyToken, [txt(buildResultText(poll, true)), buildVoteFlex(poll)]);
    }

    // 關團
    if (cmd === "關團" || cmd === "取消") {
      if (polls[gid]) {
        delete polls[gid];
        return reply(event.replyToken, [txt("已關團，這次投票清空。想再揪打「開團」。")]);
      }
      return reply(event.replyToken, [txt("目前沒有進行中的團")]);
    }
  }
}

app.get("/", (req, res) => res.send("🏀 HOOPS LINE bot v2 is running"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HOOPS bot v2 listening on " + PORT));
