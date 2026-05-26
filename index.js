// =============================================================
//  🏀 HOOPS — LINE 籃球約團投票機器人
//  發起人開團 → 大家在群組點按鈕投票 → 即時統計、記名 + 人數
// =============================================================
//
//  指令（在 LINE 群組裡輸入）：
//    /開團 標題 | 場地           例: /開團 週日籃球 | 中山運動中心
//    /加時段 5/31 18:00-20:00    （開團後逐個加，可加多筆）
//    /結果                       看目前票數與名單
//    /關團                       清掉這次的團，重新開
//    /help                       看說明
//
//  投票方式：機器人會把每個時段做成按鈕，群組成員直接點按鈕即可。
//  一個人可複選多個時段；再點一次同一時段＝取消。
// =============================================================

const express = require("express");
const crypto = require("crypto");
const https = require("https");

const app = express();

// LINE 設定（從環境變數讀，部署時填）
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

// ------- 資料儲存（記憶體版；重啟會清空，足夠約團這種短期用途） -------
// polls[groupId] = { title, venue, slots: [{ id, label, voters: [name] }] }
const polls = {};

function getDisplayName(source) {
  // 取得使用者顯示名稱需呼叫 LINE API；為了簡單，先用 userId 末碼當代稱，
  // 並提供「/我是 名字」讓使用者自訂顯示名。實務上多數人會先設定一次。
  return null;
}

// userId -> 自訂名字
const nameMap = {};

// =============================================================
//  LINE 回覆工具
// =============================================================
function lineReply(replyToken, messages) {
  const body = JSON.stringify({ replyToken, messages });
  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/reply",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + CHANNEL_TOKEN,
      "Content-Length": Buffer.byteLength(body),
    },
  };
  const req = https.request(options, (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => {
      if (res.statusCode >= 300) console.error("LINE reply error:", res.statusCode, d);
    });
  });
  req.on("error", (e) => console.error("LINE reply request error:", e));
  req.write(body);
  req.end();
}

// 文字訊息
function txt(text) {
  return { type: "text", text };
}

// 把時段做成可點的投票卡片（Flex）
function buildVoteFlex(poll) {
  const rows = poll.slots.map((s) => ({
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      {
        type: "button",
        style: "primary",
        color: "#ff6a2b",
        height: "sm",
        action: { type: "postback", label: "投 " + s.label, data: "vote:" + s.id, displayText: "我投 " + s.label },
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
          { type: "text", text: "🏀 " + poll.title, weight: "bold", size: "lg", color: "#ffffff" },
          poll.venue
            ? { type: "text", text: "📍 " + poll.venue, size: "sm", color: "#aaaaaa" }
            : { type: "filler" },
          { type: "separator", color: "#333333" },
          { type: "text", text: "點按鈕投票（可複選，再點一次取消）", size: "xs", color: "#888888" },
          ...rows,
        ],
      },
      styles: { body: { backgroundColor: "#181b22" } },
    },
  };
}

function buildResultText(poll) {
  const sorted = poll.slots.slice().sort((a, b) => b.voters.length - a.voters.length);
  let t = "🏀 " + poll.title + "\n";
  if (poll.venue) t += "📍 " + poll.venue + "\n";
  t += "\n目前票數：\n";
  sorted.forEach((s, i) => {
    const crown = i === 0 && s.voters.length > 0 ? "👑 " : "";
    t += crown + s.label + "　" + s.voters.length + "人";
    if (s.voters.length) t += "（" + s.voters.join("、") + "）";
    t += "\n";
  });
  if (sorted.every((s) => s.voters.length === 0)) t += "（還沒有人投票）\n";
  return t.trim();
}

// =============================================================
//  Webhook
// =============================================================
// 用 raw body 才能驗章
app.use("/webhook", express.raw({ type: "*/*" }));

app.post("/webhook", (req, res) => {
  // 驗證 LINE 簽章
  const signature = req.headers["x-line-signature"];
  const hash = crypto.createHmac("sha256", CHANNEL_SECRET).update(req.body).digest("base64");
  if (signature !== hash) {
    console.error("簽章驗證失敗");
    return res.status(401).send("bad signature");
  }
  res.status(200).end(); // 先回 200，LINE 才不會重送

  let payload;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    return;
  }

  (payload.events || []).forEach((event) => handleEvent(event));
});

function groupKeyOf(source) {
  return source.groupId || source.roomId || source.userId;
}

function handleEvent(event) {
  const source = event.source || {};
  const gid = groupKeyOf(source);
  const uid = source.userId || "anon";

  // ---------- 點按鈕投票 ----------
  if (event.type === "postback") {
    const data = event.postback.data || "";
    if (data.startsWith("vote:")) {
      const slotId = data.slice(5);
      const poll = polls[gid];
      if (!poll) return lineReply(event.replyToken, [txt("這個群組還沒開團，先打「/開團 標題 | 場地」")]);
      const name = nameMap[uid] || ("球友" + uid.slice(-4));
      const slot = poll.slots.find((s) => s.id === slotId);
      if (!slot) return;
      const idx = slot.voters.indexOf(name);
      if (idx > -1) slot.voters.splice(idx, 1); // 再點＝取消
      else slot.voters.push(name);
      return lineReply(event.replyToken, [buildVoteFlex(poll), txt(buildResultText(poll))]);
    }
    return;
  }

  // ---------- 文字指令 ----------
  if (event.type === "message" && event.message.type === "text") {
    const text = event.message.text.trim();

    if (text === "/help" || text === "/說明") {
      return lineReply(event.replyToken, [
        txt(
          "🏀 約團投票指令：\n\n" +
            "/開團 標題 | 場地\n" +
            "　例：/開團 週日籃球 | 中山運動中心\n\n" +
            "/加時段 5/31 18:00-20:00\n" +
            "　（開團後逐個加，可加多筆）\n\n" +
            "/我是 你的名字\n" +
            "　（投票顯示這個名字）\n\n" +
            "/結果　看目前票數\n" +
            "/關團　結束這次的團"
        ),
      ]);
    }

    if (text.startsWith("/我是")) {
      const n = text.replace("/我是", "").trim();
      if (!n) return lineReply(event.replyToken, [txt("用法：/我是 你的名字")]);
      nameMap[uid] = n;
      return lineReply(event.replyToken, [txt("好的，投票會顯示你是「" + n + "」")]);
    }

    if (text.startsWith("/開團")) {
      const rest = text.replace("/開團", "").trim();
      let title = rest, venue = "";
      if (rest.includes("|")) {
        const parts = rest.split("|");
        title = parts[0].trim();
        venue = parts[1].trim();
      }
      polls[gid] = { title: title || "籃球揪團", venue, slots: [] };
      return lineReply(event.replyToken, [
        txt("✅ 已開團：" + (title || "籃球揪團") + (venue ? "（" + venue + "）" : "") + "\n\n接著用「/加時段 5/31 18:00-20:00」把可預約的時段加進來。"),
      ]);
    }

    if (text.startsWith("/加時段")) {
      const label = text.replace("/加時段", "").trim();
      const poll = polls[gid];
      if (!poll) return lineReply(event.replyToken, [txt("還沒開團，先打「/開團 標題 | 場地」")]);
      if (!label) return lineReply(event.replyToken, [txt("用法：/加時段 5/31 18:00-20:00")]);
      poll.slots.push({ id: "s" + (poll.slots.length + 1) + Date.now().toString(36).slice(-3), label, voters: [] });
      return lineReply(event.replyToken, [txt("已加入時段：" + label), buildVoteFlex(poll)]);
    }

    if (text === "/結果") {
      const poll = polls[gid];
      if (!poll) return lineReply(event.replyToken, [txt("這個群組還沒開團")]);
      return lineReply(event.replyToken, [buildVoteFlex(poll), txt(buildResultText(poll))]);
    }

    if (text === "/關團") {
      if (polls[gid]) {
        delete polls[gid];
        return lineReply(event.replyToken, [txt("已關團，這次的投票清空了。想再揪打「/開團」。")]);
      }
      return lineReply(event.replyToken, [txt("目前沒有進行中的團")]);
    }
  }
}

// 健康檢查用（部署平台會打這個確認服務活著）
app.get("/", (req, res) => res.send("🏀 HOOPS LINE bot is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HOOPS bot listening on " + PORT));
