require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY;

// Simple in-memory store for executions (for demo only)
const executions = new Map();

// --- Rail configuration (simulated) ---

const RAILS = {
  swift_wire: {
    id: "swift_wire",
    displayName: "Traditional SWIFT bank wire",
    baseFeeAED: 150,
    variableFeePct: 0.4,
    fxSpreadPct: 0.7,
    settlementMinutes: 2160, // 1.5 days
  },
  local_rtp: {
    id: "local_rtp",
    displayName: "GCC Real-Time Payments Hub",
    baseFeeAED: 25,
    variableFeePct: 0.1,
    fxSpreadPct: 0.3,
    settlementMinutes: 30,
  },
  stablecoin_partner: {
    id: "stablecoin_partner",
    displayName: "Partner Stablecoin Rail",
    baseFeeAED: 5,
    variableFeePct: 0.05,
    fxSpreadPct: 0.15,
    settlementMinutes: 5,
  },
  orchestrated_bank_bundle: {
    id: "orchestrated_bank_bundle",
    displayName: "AiriPay Orchestrated Bank Router",
    baseFeeAED: 10,
    variableFeePct: 0.08,
    fxSpreadPct: 0.2,
    settlementMinutes: 15,
  },
};

// --- Middleware ---

app.use(cors());
app.use(express.json());

// Simple API key auth
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    // If no key configured, allow all (dev mode)
    return next();
  }
  const key = req.header("X-API-Key");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

// Apply auth only to API endpoints
app.use(requireApiKey);

// --- Helpers ---

function computeRailQuote(railConfig, { amount, urgencyHours, allowCrypto, riskTolerance }) {
  const { id, displayName, baseFeeAED, variableFeePct, fxSpreadPct, settlementMinutes } =
    railConfig;

  // Basic cost model
  const variableFeeAED = (amount * variableFeePct) / 100;
  const fxSpreadAED = (amount * fxSpreadPct) / 100;
  const totalCost = baseFeeAED + variableFeeAED + fxSpreadAED;

  let meetsUrgency = true;
  if (typeof urgencyHours === "number" && !Number.isNaN(urgencyHours)) {
    const maxMinutes = urgencyHours * 60;
    meetsUrgency = settlementMinutes <= maxMinutes;
  }

  // Risk tolerance logic (very simple for demo)
  let suitsRiskTolerance = true;
  if (riskTolerance === "low" && id === "stablecoin_partner") {
    suitsRiskTolerance = false;
  }

  let riskNotes = "";
  if (id === "stablecoin_partner") {
    riskNotes =
      "Uses a partner stablecoin rail; subject to on/off-ramp and digital asset partner risk.";
  } else if (id === "swift_wire") {
    riskNotes = "Conventional SWIFT wire with correspondent bank risk and higher FX spread.";
  } else if (id === "local_rtp") {
    riskNotes = "Local real-time payment rail; low latency, relies on connected GCC systems.";
  } else if (id === "orchestrated_bank_bundle") {
    riskNotes =
      "AiriPay orchestrates across connected banks/PSPs; this is a meta-route, not a new rail.";
  }

  return {
    id,
    displayName,
    totalCost: Number(totalCost.toFixed(2)),
    totalCostCurrency: "AED",
    estimatedSettlementMinutes: settlementMinutes,
    meetsUrgency,
    suitsRiskTolerance,
    feesBreakdown: {
      baseFeeAED: Number(baseFeeAED.toFixed(2)),
      variableFeeAED: Number(variableFeeAED.toFixed(2)),
      fxSpreadAED: Number(fxSpreadAED.toFixed(2)),
    },
    steps: [
      `Initiate payment via ${displayName}`,
      "Process through connected bank/PSP infrastructure",
      "Settle funds to beneficiary account",
    ],
    riskNotes,
  };
}

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

// --- Routes ---

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "airipay_bank_orchestration" });
});

// POST /simulate-payment
app.post("/simulate-payment", (req, res) => {
  const {
    amount,
    sourceCurrency = "AED",
    destinationCurrency = "SAR",
    urgencyHours,
    allowCrypto = true,
    riskTolerance = "medium",
    metadata = {},
  } = req.body || {};

  if (typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "Invalid or missing 'amount' (must be > 0 number)" });
  }

  // Build quotes for each rail
  const context = { amount, urgencyHours, allowCrypto, riskTolerance };

  const railIds = Object.keys(RAILS).filter((id) => {
    if (!allowCrypto && id === "stablecoin_partner") return false;
    return true;
  });

  const quotes = railIds.map((id) => computeRailQuote(RAILS[id], context));

  // Determine recommended rail:
  // 1. Prefer rails that meet urgency
  // 2. Within those, choose lowest totalCost
  // 3. If none meet urgency, choose lowest totalCost overall
  let candidates = quotes.filter((q) => q.meetsUrgency);
  if (candidates.length === 0) {
    candidates = quotes;
  }

  let recommendedRoute = candidates.reduce((best, q) =>
    !best || q.totalCost < best.totalCost ? q : best
  , null);

  const alternatives = quotes
    .filter((q) => q.id !== recommendedRoute.id)
    .sort((a, b) => a.totalCost - b.totalCost);

  const paymentId = generateId("pay_sim");

  const summary = `Simulated ${
    railIds.length
  } rails for ${amount} ${sourceCurrency}->${destinationCurrency}. Recommended ${
    recommendedRoute.displayName
  } with estimated cost ${recommendedRoute.totalCost} AED and settlement in ~${recommendedRoute.estimatedSettlementMinutes} minutes.`;

  const assumptions = [
    !urgencyHours && "No 'urgencyHours' provided; used default settlement expectations.",
    sourceCurrency !== "AED" && `Source currency assumed as ${sourceCurrency}.`,
    destinationCurrency !== "SAR" && `Destination currency assumed as ${destinationCurrency}.`,
    !allowCrypto && "Crypto/stablecoin partner rail disabled by policy.",
  ]
    .filter(Boolean)
    .join(" ");

  const responseBody = {
    paymentId,
    amount,
    sourceCurrency,
    destinationCurrency,
    summary,
    assumptions,
    selectedRail: recommendedRoute,
    alternatives,
  };

  res.json(responseBody);
});

// POST /execute-payment
app.post("/execute-payment", (req, res) => {
  const { runId, simulateOnly = false, payments } = req.body || {};

  if (!Array.isArray(payments) || payments.length === 0) {
    return res
      .status(400)
      .json({ error: "Invalid or missing 'payments' (must be non-empty array)" });
  }

  const executionId = generateId("exec");
  const now = new Date().toISOString();

  const summary = `Execution ${simulateOnly ? "simulated" : "completed"} for ${
    payments.length
  } payments.`;

  // For demo, we instantly mark as completed
  const executionRecord = {
    executionId,
    status: "completed",
    summary,
    createdAt: now,
    completedAt: now,
    simulateOnly,
    paymentsStatus: payments.map((p) => ({
      externalInvoiceId: p.externalInvoiceId || null,
      status: "completed",
      message: simulateOnly
        ? "Simulated execution only (no real transfer)."
        : "Executed in demo environment.",
    })),
  };

  executions.set(executionId, executionRecord);

  const responseBody = {
    executionId,
    status: executionRecord.status,
    summary: executionRecord.summary,
    createdAt: executionRecord.createdAt,
    simulateOnly: executionRecord.simulateOnly,
    payments,
  };

  res.json(responseBody);
});

// GET /payment-status/:executionId
app.get("/payment-status/:executionId", (req, res) => {
  const { executionId } = req.params;
  const record = executions.get(executionId);

  if (!record) {
    return res.status(404).json({ error: "Execution not found" });
  }

  const responseBody = {
    executionId: record.executionId,
    status: record.status,
    summary: record.summary,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    simulateOnly: record.simulateOnly,
    payments: record.paymentsStatus,
  };

  res.json(responseBody);
});

// Start server
app.listen(PORT, () => {
  console.log(`AiriPay bank orchestration API listening on port ${PORT}`);
});
