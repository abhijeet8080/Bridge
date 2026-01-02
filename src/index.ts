import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();
import { producer, rfqQueue } from "./queue";

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

app.post("/sales-quote-webhook", async (req, res) => {
  try {
    console.log("📥 Sales Quote webhook received");

    const payload = req.body;

    // Log full payload for traceability
    console.log("📋 Sales Quote Payload:", JSON.stringify(payload, null, 2));

    // Validate required fields
    if (!payload.salesQuoteNo || !payload.opportunityNo) {
      console.warn("⚠️ Missing required fields: salesQuoteNo or opportunityNo");
      return res.status(400).json({
        error: "Missing required fields (salesQuoteNo, opportunityNo)",
      });
    }

    if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
      console.warn("⚠️ Sales quote has no lines");
      return res.status(400).json({
        error: "Sales quote must have at least one line",
      });
    }

    // Transform payload to match CustomerQuoteSyncJobData interface
    const jobData = {
      salesQuoteNo: payload.salesQuoteNo,
      salesQuoteSystemId: payload.salesQuoteSystemId || payload.systemId || "",
      customerNo: payload.customerNo || "",
      customerName: payload.customerName || "",
      opportunityNo: payload.opportunityNo,
      accountManager: payload.accountManager || "",
      currencyCode: payload.currencyCode || "",
      quoteValidUntil: payload.quoteValidUntil || payload.validUntil || "",
      validityDays: payload.validityDays || 30, // Default to 30 if not provided
      totalAmount: payload.totalAmount || 0,
      issuedAt: payload.issuedAt || payload.createdAt || new Date().toISOString(),
      lines: payload.lines.map((line: any) => ({
        lineNo: line.lineNo,
        lineSystemId: line.lineSystemId || line.systemId || "",
        itemNo: line.itemNo || "",
        internalItemId: line.internalItemId || line.itemNo || "",
        description: line.description || "",
        quantity: line.quantity || 0,
        unitCost: line.unitCost || 0,
        unitPrice: line.unitPrice || 0,
        marginPercent: line.marginPercent || 0,
        lineAmount: line.lineAmount || line.unitPrice * (line.quantity || 0),
        purchaseQuoteNo: line.purchaseQuoteNo || "",
        oppNo: line.oppNo || payload.opportunityNo,
        convertToOrder: line.convertToOrder !== undefined ? line.convertToOrder : true,
      })),
    };

    console.log("🧾 Customer Quote Sync Job Data:", {
      salesQuoteNo: jobData.salesQuoteNo,
      opportunityNo: jobData.opportunityNo,
      linesCount: jobData.lines.length,
    });

    // Enqueue customer quote sync job to RFQ queue
    await rfqQueue.add(
      "rfq.customer-quote-sync",
      jobData,
      {
        jobId: `customer-quote-sync-${jobData.salesQuoteNo}`, // Prevents duplicates
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24 hours
          count: 500,
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
          count: 500,
        },
      }
    );

    console.log(
      `🚀 Enqueued rfq.customer-quote-sync job for Sales Quote: ${jobData.salesQuoteNo}`
    );

    res.status(200).json({
      status: "success",
      message: "Sales quote received and enqueued for processing",
      salesQuoteNo: payload.salesQuoteNo,
      opportunityNo: payload.opportunityNo,
    });
  } catch (err) {
    console.error("❌ Failed to handle Sales Quote webhook:", err);
    res.status(500).json({
      error: "Failed to handle Sales Quote webhook",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/vendor-quote-approval-webhook", async (req, res) => {
  try {
    console.log("📥 Vendor Quote Approval webhook received");
    const payload = req.body;

    // Log full payload for traceability
    console.log("📋 Vendor Quote Approval Payload:", JSON.stringify(payload, null, 2));

    // Validate required fields
    if (!payload.mpRfqId || !payload.rfqLineNo || !payload.vendorNo || !payload.systemId) {
      console.warn("⚠️ Missing required fields in vendor quote webhook");
      return res.status(400).json({
        error: "Missing required fields (mpRfqId, rfqLineNo, vendorNo, systemId)",
      });
    }

    // Prepare webhook data matching QuoteApprovalJobData interface
    const webhookData = {
      mpRfqId: payload.mpRfqId,
      rfqLineNo: payload.rfqLineNo,
      vendorNo: payload.vendorNo,
      vendorName: payload.vendorName,
      unitCost: payload.unitCost,
      currencyCode: payload.currencyCode,
      leadTimeDays: payload.leadTimeDays,
      moq: payload.moq,
      validTillDate: payload.validTillDate,
      quoteSource: payload.quoteSource,
      suggestedMargin: payload.suggestedMargin,
      amMargin: payload.amMargin,
      quotedUomCode: payload.quotedUomCode,
      finalUnitPrice: payload.finalUnitPrice,
      approvalStatus: payload.approvalStatus,
      approvedBy: payload.approvedBy,
      approvedDate: payload.approvedDate,
      vendorQuoteReference: payload.vendorQuoteReference,
      systemId: payload.systemId, // This matches VendorQuote.erpRef
    };

    console.log("✅ Vendor Quote Approval Data:", {
      systemId: webhookData.systemId,
      approvalStatus: webhookData.approvalStatus,
      mpRfqId: webhookData.mpRfqId,
    });

    // Enqueue quote approval job
    // The sync processor will:
    // 1. Find VendorQuote by erpRef (systemId)
    // 2. Update approval status
    // 3. Update RFQ line and RFQ statuses
    await rfqQueue.add(
      "rfq.quote.approval",
      {
        webhookData,
      },
      {
        jobId: `quote-approval-${payload.systemId}`, // Prevents duplicates
        removeOnComplete: {
          age: 24 * 3600,
          count: 500,
        },
      }
    );

    console.log(
      `🚀 Enqueued rfq.quote.approval job for systemId: ${payload.systemId}`
    );

    res.status(200).json({
      status: "success",
      message: "Vendor quote approval received and enqueued",
      mpRfqId: payload.mpRfqId,
      rfqLineNo: payload.rfqLineNo,
      vendorNo: payload.vendorNo,
      approvalStatus: payload.approvalStatus,
    });
  } catch (err) {
    console.error("❌ Failed to handle Vendor Quote Approval webhook:", err);
    res.status(500).json({
      error: "Failed to handle Vendor Quote Approval webhook",
      message: err instanceof Error ? err.message : String(err),
    });
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
// POST endpoint for receiving email notifications from Microsoft Graph
app.post("/graph/webhook", async (req, res) => {
  try {
    console.log("📥 POST /graph/webhook received");
    console.log("📋 Content-Type:", req.headers["content-type"]);

    // 1️⃣ Subscription validation handling
    const validationToken = req.query.validationToken as string;
    if (validationToken) {
      console.log("🔑 Microsoft Graph subscription validation (query param)");
      return res
        .status(200)
        .set("Content-Type", "text/plain")
        .send(validationToken);
    }

    // Body-as-text validation case
    if (
      typeof req.body === "string" &&
      req.body.length < 200 &&
      !req.body.startsWith("{")
    ) {
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
      const { subscriptionId, changeType, resource, resourceData } =
        notification;

      console.log("📧 Graph notification:", {
        subscriptionId,
        changeType,
        resource,
        resourceData,
        timestamp: new Date().toISOString(),
      });

      // Only trigger job when a new message is created
      if (
        changeType === "created" &&
        resource?.toLowerCase().includes("/messages/")
      ) {
        const messageId = resourceData?.id;
        
        if (!messageId) {
          console.warn("⚠️ Message ID missing in notification");
          continue;
        }

        console.log(
          `📨 Email detected (messageId: ${messageId}) — enqueuing quote ingestion job`
        );

        try {
          // Enqueue quote ingestion job with messageId
          // The sync processor will:
          // 1. Fetch email from Graph using messageId
          // 2. Parse email using AI to extract responseToken and quote data
          // 3. Find VendorRfq by responseToken
          // 4. Create VendorQuote if classification is QUOTE
          // 5. Enqueue vendor quote sync job to sync to BC
          await rfqQueue.add(
            "rfq.quote-ingestion", // Updated: use hyphen instead of dots to match sync service
            {
              messageId, // Processor will fetch email and find VendorRfq
            },
            {
              jobId: `quote-ingestion-${messageId}`, // Prevents duplicates
              removeOnComplete: {
                age: 24 * 3600,
                count: 500,
              },
            }
          );

          console.log(
            `🚀 Enqueued rfq.quote-ingestion job for messageId: ${messageId}`
          );
        } catch (error: any) {
          console.error(
            `❌ Failed to enqueue quote ingestion job for messageId ${messageId}:`,
            error?.message || error
          );
          // Continue processing other notifications
        }
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
