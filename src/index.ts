import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import { producer } from "./queue";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// webhook endpoint
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  if (!payload?.table || !payload?.action || !payload?.data) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    await producer.add("bc-sync", payload);
    console.log("✅ Job enqueued:", payload.table, payload.action);

    res.status(202).json({ status: "accepted" });
  } catch (err) {
    console.error("❌ Failed to enqueue job:", err);
    res.status(500).json({ error: "Failed to enqueue job" });
  }
});

app.get("/health", async (_req, res) => {
  try {
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "error", detail: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 HTTP Service listening on http://localhost:${PORT}`);
});
