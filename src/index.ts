import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import { producer } from "./queue";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(bodyParser.text({ type: "text/plain" }));

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
    const notifications = req.body;
    
    // Microsoft Graph sends notifications in this format:
    // { value: [{ subscriptionId, changeType, resource, resourceData, ... }] }
    if (!notifications?.value || !Array.isArray(notifications.value)) {
      console.warn("⚠️ Invalid Microsoft Graph notification format:", notifications);
      return res.status(400).json({ error: "Invalid notification format" });
    }

    // Process each notification
    for (const notification of notifications.value) {
      const { subscriptionId, changeType, resource, resourceData } = notification;
      
      console.log("📧 Microsoft Graph notification received:", {
        subscriptionId,
        changeType,
        resource,
        resourceData,
        timestamp: new Date().toISOString(),
      });
      
      // Only process email-related notifications
      if (changeType === "created" && resource?.includes("/messages")) {
        console.log(`✅ Email notification detected for subscription: ${subscriptionId}`);
        console.log("📨 Email resource:", resource);
        if (resourceData) {
          console.log("📋 Email resource data:", JSON.stringify(resourceData, null, 2));
        }
      } else {
        console.log(`ℹ️ Skipping notification - changeType: ${changeType}, resource: ${resource}`);
      }
    }

    // Microsoft Graph expects a 202 Accepted response
    res.status(202).json({ status: "accepted" });
  } catch (err) {
    console.error("❌ Failed to handle Microsoft Graph webhook:", err);
    res.status(500).json({ error: "Failed to handle webhook" });
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
