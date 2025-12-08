import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import { producer } from "./queue";

const app = express();
const PORT = process.env.PORT || 3000;

// Handle both text/plain (for validation) and JSON (for notifications)
// Microsoft Graph sends validation tokens as plain text
app.use(bodyParser.text({ type: ["text/plain", "text"], limit: "1mb" }));
app.use(bodyParser.json());

// --- Debounce map to hold pending timers per record ---
const pendingEvents = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 10_000; // 10 seconds debounce

// webhook endpoint
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  if (!payload?.table || !payload?.action || !payload?.data) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    const table = payload.table;
    const erpNo = payload.data["No."];
    if (!erpNo) {
      console.warn("⚠️ Payload missing ERP No:", payload);
      return res.status(400).json({ error: "ERP No missing in data" });
    }

    const key = `${table}:${erpNo}`;

    // Clear any existing pending timer for this record
    if (pendingEvents.has(key)) clearTimeout(pendingEvents.get(key));

    // Set a new debounce timer
    const timeout = setTimeout(async () => {
      try {
        await producer.add("bc-sync", payload);
        console.log("✅ Debounced job enqueued:", table, payload.action);
      } catch (err) {
        console.error("❌ Failed to enqueue debounced job:", err);
      } finally {
        pendingEvents.delete(key); // clean up
      }
    }, DEBOUNCE_MS);

    pendingEvents.set(key, timeout);

    res.status(202).json({ status: "accepted", info: "Debounced" });
  } catch (err) {
    console.error("❌ Failed to handle webhook:", err);
    res.status(500).json({ error: "Failed to handle webhook" });
  }
});

// Microsoft Graph webhook endpoint for email notifications
// GET endpoint for subscription validation
app.get("/graph/webhook", (req, res) => {
  const validationToken = req.query.validationToken as string;
  
  if (validationToken) {
    // Microsoft Graph requires returning the validation token as plain text
    console.log("✅ Microsoft Graph subscription validation received");
    res.status(200).set("Content-Type", "text/plain").send(validationToken);
  } else {
    res.status(400).json({ error: "Missing validationToken" });
  }
});

// POST endpoint for receiving email notifications from Microsoft Graph
app.post("/graph/webhook", async (req, res) => {
  try {
    console.log("📥 POST /graph/webhook received");
    console.log("📋 Content-Type:", req.headers["content-type"]);
    console.log("📋 Body:", req.body);

    // 1️⃣ Subscription validation handling
    const validationToken = req.query.validationToken as string;
    if (validationToken) {
      console.log("🔑 Microsoft Graph subscription validation (query param)");
      return res.status(200).set("Content-Type", "text/plain").send(validationToken);
    }

    // Body-as-text validation case
    if (typeof req.body === "string" && req.body.length < 200 && !req.body.startsWith("{")) {
      console.log("🔑 Microsoft Graph subscription validation (raw body)");
      return res.status(200).set("Content-Type", "text/plain").send(req.body);
    }

    // 2️⃣ Validate Graph notification structure
    const body = req.body;
    if (!body?.value || !Array.isArray(body.value)) {
      console.warn("⚠️ Invalid Graph notification format:", body);
      return res.status(400).json({ error: "Invalid notification format" });
    }

    // 3️⃣ Process notifications and enqueue jobs
    for (const notification of body.value) {
      const { subscriptionId, changeType, resource, resourceData } = notification;

      console.log("📧 Graph notification:", {
        subscriptionId,
        changeType,
        resource,
        resourceData,
        timestamp: new Date().toISOString(),
      });

      // Only trigger job when a new message is created
      if (changeType === "created" && resource?.toLowerCase().includes("/messages/")) {
        console.log("📨 Email detected — enqueuing job to process vendor reply");

        await producer.add(
          "process-email-reply",
          {
            model: "Email",
            operation: "vendor_reply",
            payload: {
              messageId: resourceData?.id,
              resource,
              subscriptionId,
            },
          },
          {
            jobId: `email-${resourceData?.id}`, // prevents duplicates
            removeOnComplete: true,
            removeOnFail: false,
          }
        );

        console.log(`🚀 Job enqueued → process-email-reply for message ${resourceData?.id}`);
      } else {
        console.log(
          `ℹ️ Ignored — changeType: ${changeType}, resource: ${resource}`
        );
      }
    }

    // 4️⃣ Graph requires 202 Accepted
    res.status(202).json({ status: "accepted" });
  } catch (err) {
    console.error("❌ Failed to handle Graph webhook:", err);
    res.status(500).json({ error: "Failed to handle graph webhook" });
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
