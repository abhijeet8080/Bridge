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

app.post("/sales-quote-webhook", async (req, res) => {
  try {
    console.log("📥 Sales Quote webhook received");

    const payload = req.body;

    // Log full payload for traceability
    console.log("📋 Sales Quote Payload:", JSON.stringify(payload, null, 2));
    console.log("complete payload", payload);

    // ---- Header-level data ----
    const headerInfo = {
      salesQuoteNo: payload.salesQuoteNo,
      customerNo: payload.customerNo,
      customerName: payload.customerName,
      opportunityNo: payload.opportunityNo,
      accountManager: payload.accountManager,
      currencyCode: payload.currencyCode,
      quoteValidUntil: payload.quoteValidUntil,
      totalAmount: payload.totalAmount,
      createdAt: payload.createdAt,
    };

    console.log("🧾 Sales Quote Header:", headerInfo);

    // ---- Line-level data ----
    if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
      console.warn("⚠️ Sales quote has no lines");
    } else {
      payload.lines.forEach((line: any) => {
        console.log("📦 Sales Quote Line:", {
          lineNo: line.lineNo,
          itemNo: line.itemNo,
          internalItemId: line.internalItemId,
          description: line.description,
          quantity: line.quantity,

          // Cost & price
          unitCost: line.unitCost,
          unitPrice: line.unitPrice,

          // Margin & amount
          marginPercent: line.marginPercent,
          lineAmount: line.lineAmount,

          // Traceability back to purchase quote and opportunity
          purchaseQuoteNo: line.purchaseQuoteNo,
          oppNo: line.oppNo,

          // Order conversion flag
          convertToOrder: line.convertToOrder,
        });
      });
    }

    await producer.add(
      "pg-events",
      {
        model: "CustomerQuote",
        operation: "create_from_sales_quote",
        payload: {
          header: headerInfo,
          lines: payload.lines,
        },
      },
      {
        jobId: `customer-quote-${headerInfo.salesQuoteNo}`,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );

    res.status(200).json({
      status: "success",
      message: "Sales quote received and processed",
      salesQuoteNo: payload.salesQuoteNo,
    });
  } catch (err) {
    console.error("❌ Failed to handle Sales Quote webhook:", err);
    res.status(500).json({
      error: "Failed to handle Sales Quote webhook",
    });
  }
});

app.post("/vendor-quote-approval-webhook", async (req, res) => {
  try {
    console.log("📥 Vendor Quote Approval webhook received");
    const payload = req.body;

    // Log full payload for traceability
    console.log("📋 Vendor Quote Approval Payload:", JSON.stringify(payload, null, 2));
    console.log("complete payload", payload);

    // ---- Vendor Quote Approval Data ----
    const vendorQuoteInfo = {
      // RFQ Information
      mpRfqId: payload.mpRfqId,
      rfqLineNo: payload.rfqLineNo,
      
      // Vendor Information
      vendorNo: payload.vendorNo,
      vendorName: payload.vendorName,
      
      // Approval Status
      approvalStatus: payload.approvalStatus,
      approvedBy: payload.approvedBy,
      approvedDate: payload.approvedDate,
      
      // Pricing Information
      unitCost: payload.unitCost,
      currencyCode: payload.currencyCode,
      suggestedMargin: payload.suggestedMargin,
      amMargin: payload.amMargin,
      finalUnitPrice: payload.finalUnitPrice,
      
      // Quote Details
      leadTimeDays: payload.leadTimeDays,
      moq: payload.moq,
      validTillDate: payload.validTillDate,
      quotedUomCode: payload.quotedUomCode,
      quoteSource: payload.quoteSource,
      
      // References
      vendorQuoteReference: payload.vendorQuoteReference,
      systemId: payload.systemId,
    };

    console.log("✅ Vendor Quote Details:", vendorQuoteInfo);

    // Log key business information
    console.log("💰 Pricing Breakdown:", {
      unitCost: vendorQuoteInfo.unitCost,
      amMargin: `${vendorQuoteInfo.amMargin}%`,
      finalUnitPrice: vendorQuoteInfo.finalUnitPrice,
      currency: vendorQuoteInfo.currencyCode,
    });

    console.log("📦 Logistics:", {
      leadTime: `${vendorQuoteInfo.leadTimeDays} days`,
      moq: vendorQuoteInfo.moq,
      validUntil: vendorQuoteInfo.validTillDate,
    });

    console.log("👤 Approval Info:", {
      status: vendorQuoteInfo.approvalStatus,
      approvedBy: vendorQuoteInfo.approvedBy,
      approvedDate: vendorQuoteInfo.approvedDate,
    });

    // Validate required fields
    if (!payload.mpRfqId || !payload.rfqLineNo || !payload.vendorNo) {
      console.warn("⚠️ Missing required fields in vendor quote webhook");
      return res.status(400).json({
        error: "Missing required fields (mpRfqId, rfqLineNo, vendorNo)",
      });
    }

    // Check approval status
    // if (payload.approvalStatus === "Approved") {
    //   console.log("✅ Vendor quote APPROVED");
      
    //   // Add to queue for processing
    //   await producer.add(
    //     "pg-events",
    //     {
    //       model: "VendorQuoteApproval",
    //       operation: "process_approval",
    //       payload: vendorQuoteInfo,
    //     },
    //     {
    //       jobId: `vendor-quote-${payload.mpRfqId}-${payload.rfqLineNo}-${payload.vendorNo}`,
    //       removeOnComplete: true,
    //       removeOnFail: false,
    //     }
    //   );
    // } else if (payload.approvalStatus === "Rejected") {
    //   console.log("❌ Vendor quote REJECTED");
      
    //   // Handle rejection
    //   await producer.add(
    //     "pg-events",
    //     {
    //       model: "VendorQuoteApproval",
    //       operation: "process_rejection",
    //       payload: vendorQuoteInfo,
    //     },
    //     {
    //       jobId: `vendor-quote-reject-${payload.mpRfqId}-${payload.rfqLineNo}-${payload.vendorNo}`,
    //       removeOnComplete: true,
    //       removeOnFail: false,
    //     }
    //   );
    // }

    res.status(200).json({
      status: "success",
      message: "Vendor quote approval received and processed",
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
app.post("/graph/webhook", async (req, res) => {
  try {
    console.log("📥 POST /graph/webhook received");
    console.log("📋 Content-Type:", req.headers["content-type"]);
    console.log("📋 Body:", req.body);

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
        console.log(
          "📨 Email detected — enqueuing job to process vendor reply"
        );

        await producer.add(
          "email.vendor_reply",
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

        console.log(
          `🚀 Job enqueued → process-email-reply for message ${resourceData?.id}`
        );
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
