// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { google } from "googleapis";

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

const auth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  undefined,
  (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// مساعد: يجلب كل صفوف الورقة
async function getSheetRows() {
  const range = `${SHEET_NAME}!A:I`; // حتى العامود I
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  return res.data.values || [];
}

// مساعد: تقسيم كتل الطلبات داخل نص العامود I
function splitBlocks(raw) {
  return (raw || "")
    .split("||")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// مساعد: استخراج معرف الطلب من الكتلة
function getId(block) {
  const line = block.split("\n").find(l => l.trim().startsWith("معرف الطلب:"));
  if (!line) return null;
  return line.replace("معرف الطلب:", "").trim();
}

// مساعد: يدخل الرد والحالة تحت "رابط الملف:" داخل الكتلة
function injectResponseAndStatus(block, responseText, decision) {
  const lines = block.split("\n");
  const result = [];
  let inserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result.push(line);
    if (!inserted && line.trim().startsWith("رابط الملف:")) {
      // ندخل أسطر بعد هذا السطر
      result.push(`الرد: ${responseText || "—"}`);
      const status = decision === "accept" ? "تم قبول الطلب" : "تم رفض الطلب";
      result.push(`الحالة: ${status}`);
      inserted = true;
    }
  }

  // إذا لم نجد "رابط الملف:" نضعهم في نهاية الكتلة
  if (!inserted) {
    result.push(`الرد: ${responseText || "—"}`);
    const status = decision === "accept" ? "تم قبول الطلب" : "تم رفض الطلب";
    result.push(`الحالة: ${status}`);
  }

  return result.join("\n");
}

// GET /orders — يعيد محتويات العامود I لكل صف
app.get("/orders", async (req, res) => {
  try {
    const rows = await getSheetRows();
    if (!rows.length) return res.json([]);

    const header = rows[0];
    const orderColIndex = header.findIndex(h => h && h.trim().toLowerCase() === "order");
    // إن لم يوجد عامود باسم 'order' نحاول استخدام I مباشرة
    const I_INDEX = 8; // صفرّي: A=0 ... I=8
    const colIndex = orderColIndex >= 0 ? orderColIndex : I_INDEX;

    const data = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rawText = (row[colIndex] || "").trim();
      if (!rawText) continue;
      data.push({ rowIndex: r + 1, rawText }); // +1 لأن A1 notation
    }

    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_fetch_orders" });
  }
});

// POST /orders/:id/respond — يدرج الرد والحالة في الكتلة المطابقة
app.post("/orders/:id/respond", async (req, res) => {
  try {
    const orderId = req.params.id;
    const { response, decision } = req.body;
    if (!orderId || !decision || !["accept", "reject"].includes(decision)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const rows = await getSheetRows();
    if (!rows.length) return res.status(404).json({ error: "sheet_empty" });

    const header = rows[0];
    const orderColIndex = header.findIndex(h => h && h.trim().toLowerCase() === "order");
    const I_INDEX = 8;
    const colIndex = orderColIndex >= 0 ? orderColIndex : I_INDEX;

    let found = false;

    // نبحث في كل صف ضمن العامود I عن كتلة فيها المعرف
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rawText = (row[colIndex] || "").trim();
      if (!rawText) continue;

      const blocks = splitBlocks(rawText);
      const updatedBlocks = blocks.map(b => {
        const id = getId(b);
        if (id && id === orderId) {
          found = true;
          return injectResponseAndStatus(b, response, decision);
        }
        return b;
      });

      if (found) {
        const newCellValue = updatedBlocks.join("||");
        const updateRange = `${SHEET_NAME}!${String.fromCharCode(65 + colIndex)}${r + 1}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: updateRange,
          valueInputOption: "RAW",
          requestBody: { values: [[newCellValue]] }
        });
        return res.json({ ok: true, message: "تم تحديث الطلب بنجاح", row: r + 1 });
      }
    }

    res.status(404).json({ error: "order_not_found" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_update_order" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
