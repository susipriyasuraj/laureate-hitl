import axios from "axios";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { opusHitlWebhookSchema } from "../schemas/opusHitlWebhookSchema.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateIncomingWebhook = ajv.compile(opusHitlWebhookSchema);

const TYPE_ALIASES = {
  str: "string",
  string: "string",
  text: "string",
  float: "number",
  double: "number",
  decimal: "number",
  int: "integer",
  integer: "integer",
  bool: "boolean",
  boolean: "boolean",
  null: "null",
};

const SCALAR_DEFAULTS = {
  string: "",
  number: 0,
  integer: 0,
  boolean: false,
  null: null,
};

const normalizeType = (value) => TYPE_ALIASES[String(value || "").toLowerCase()] || null;

const readTyped = (source, key) => {
  const safeSource = source && typeof source === "object" ? source : {};
  const item = safeSource[key];
  if (item && typeof item === "object" && Object.hasOwn(item, "value")) {
    return item.value;
  }
  return item;
};

const toDecisionToken = (decision) => {
  const v = String(decision || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

  if (v === "raise" || v === "raise_insufficiency") return "raise_insufficiency";
  return v;
};

const toDecisionText = (decision) => {
  const token = toDecisionToken(decision);
  if (token === "approve") return "approve";
  if (token === "reject") return "reject";
  if (token === "waitlist") return "waitlist";
  if (token === "raise_insufficiency") return "raise_insufficiency";
  return token || "approve";
};

export const isCanonicalHitlPayload = (payload = {}) => {
  return Boolean(
    payload?.execution_id &&
      payload?.workflow_id &&
      payload?.inputs?.review_node?.value &&
      payload?.callback?.url &&
      payload?.callback?.token &&
      payload?.callback?.token_header &&
      payload?.expected_output_schema?.schema
  );
};

export const validateHitlWebhookPayload = (payload = {}) => {
  const ok = validateIncomingWebhook(payload);
  if (ok) {
    return { ok: true, errors: [] };
  }

  const errors = (validateIncomingWebhook.errors || []).map((e) => ({
    path: e.instancePath || "/",
    message: e.message || "Invalid value",
  }));

  return { ok: false, errors };
};

export const buildHitlTaskFromWebhook = (payload = {}) => {
  const reviewValue = payload.inputs?.review_node?.value || {};
  const inputValues = reviewValue.input || {};
  const outputValues = reviewValue.output || {};
  const expectedSchema = payload.expected_output_schema || { schema: {} };

  const studentId =
    readTyped(inputValues, "student_id") ||
    readTyped(inputValues, "studentId") ||
    readTyped(inputValues, "student_id_input") ||
    `hitl-${payload.execution_id}`;

  const applicantName =
    readTyped(inputValues, "applicant_name") ||
    readTyped(inputValues, "applicantName") ||
    readTyped(inputValues, "name") ||
    `Applicant ${studentId}`;

  return {
    jobId: String(payload.execution_id),
    studentId: String(studentId),
    applicant_name: String(applicantName),
    request_type: "Off Platform Review",
    case_status: "Open",
    application_status: "Pending Review",
    decision: "Pending Review",
    status: "HITL_PENDING",
    isOffPlatformReview: true,
    available_actions: ["approve", "reject", "waitlist", "raise_insufficiency"],
    submittedAt: new Date().toLocaleString("en-GB"),
    offPlatformThreadId: String(payload.execution_id),
    offPlatformLinkageMethod: "opus_hitl_execution_id",
    offPlatformLinkageMatchedBy: String(payload.execution_id),
    offPlatformLinkedAt: new Date().toISOString(),

    hitlExecutionId: String(payload.execution_id),
    hitlWorkflowId: String(payload.workflow_id),
    hitlWorkflowName: String(payload.workflow_name || ""),
    hitlNodeExecutionId: String(reviewValue.node_execution_id || ""),

    hitlInputs: inputValues,
    hitlNodeOutput: outputValues,
    hitlInputSchema: reviewValue.input_schema || {},
    hitlNodeOutputSchema: reviewValue.output_schema || {},
    hitlProcess: reviewValue.process || {},

    hitlCallback: {
      url: String(payload.callback?.url || ""),
      token: String(payload.callback?.token || ""),
      token_header: String(payload.callback?.token_header || ""),
    },
    hitlExpectedOutputSchema: expectedSchema,
    hitlStatus: "PENDING",
    hitlAuditLog: [
      {
        type: "webhook_received",
        at: new Date().toISOString(),
        execution_id: String(payload.execution_id),
        workflow_id: String(payload.workflow_id),
      },
    ],
    offPlatformPayload: payload,
  };
};

const candidateValueForVar = (varDef = {}, context = {}) => {
  const varName = String(varDef.variable_name || "");
  const varId = String(varDef.id || "");
  const lowered = varName.toLowerCase();
  const decisionText = toDecisionText(context.humanDecision);

  const fromUser =
    context.reviewerOutput?.[varName] ??
    context.reviewerOutput?.[varId] ??
    context.reviewerOutput?.[lowered];
  if (fromUser !== undefined) return fromUser;

  const fromNodeOutput =
    readTyped(context.hitlNodeOutput, varName) ?? readTyped(context.hitlNodeOutput, varId);
  if (fromNodeOutput !== undefined) return fromNodeOutput;

  const fromInput = readTyped(context.hitlInputs, varName) ?? readTyped(context.hitlInputs, varId);
  if (fromInput !== undefined) return fromInput;

  if (
    lowered.includes("decision") ||
    lowered.includes("status") ||
    lowered.includes("recommend") ||
    lowered.includes("action")
  ) {
    return decisionText;
  }

  if (lowered.includes("amount") || lowered.includes("score") || lowered.includes("count")) {
    const reqAmount =
      readTyped(context.hitlInputs, "requested_amount") ||
      readTyped(context.hitlInputs, "amount") ||
      readTyped(context.hitlInputs, "requestedAmount");
    if (reqAmount !== undefined) {
      return decisionText === "approve" ? reqAmount : 0;
    }
  }

  return undefined;
};

const valueMatchesType = (value, normalizedType) => {
  if (normalizedType === "null") {
    return value === null;
  }

  if (normalizedType === "string") {
    return typeof value === "string";
  }

  if (normalizedType === "boolean") {
    return typeof value === "boolean";
  }

  if (normalizedType === "integer") {
    return Number.isInteger(value);
  }

  if (normalizedType === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }

  return false;
};

const castToAllowedType = (value, allowed) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  for (const allowedType of allowed) {
    if (valueMatchesType(value, allowedType)) return value;

    if (allowedType === "string") {
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      continue;
    }

    if (allowedType === "number") {
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      continue;
    }

    if (allowedType === "integer") {
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
      }
      if (typeof value === "number" && Number.isInteger(value)) {
        return value;
      }
      continue;
    }

    if (allowedType === "boolean") {
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return true;
        if (["false", "0", "no"].includes(normalized)) return false;
      }
    }
  }

  return value;
};

export const buildAndValidateHitlOutput = ({
  expectedOutputSchema,
  reviewerOutput,
  humanDecision,
  hitlInputs,
  hitlNodeOutput,
}) => {
  const schema = expectedOutputSchema?.schema || {};
  const variableAdditionAllowed = Boolean(expectedOutputSchema?.variable_addition_allowed);
  const outputByVarName = {};
  const errors = [];

  const context = {
    reviewerOutput: reviewerOutput || {},
    humanDecision,
    hitlInputs: hitlInputs || {},
    hitlNodeOutput: hitlNodeOutput || {},
  };

  for (const varDef of Object.values(schema)) {
    const variableName = String(varDef?.variable_name || "");
    const allowed = (Array.isArray(varDef?.allowed_types) ? varDef.allowed_types : [])
      .map((item) => normalizeType(item?.type))
      .filter(Boolean);

    const fallbackType = allowed[0] || "string";
    let value = candidateValueForVar(varDef, context);

    if (value === undefined) {
      if (varDef?.is_nullable === true || allowed.includes("null")) {
        value = null;
      } else {
        value = SCALAR_DEFAULTS[fallbackType];
      }
    }

    value = castToAllowedType(value, allowed);

    const isNullable = varDef?.is_nullable === true || allowed.includes("null");
    if (value === null && !isNullable) {
      errors.push(`'${variableName}' cannot be null.`);
      continue;
    }

    if (value !== null && allowed.length > 0) {
      const validForAny = allowed.some((t) => valueMatchesType(value, t));
      if (!validForAny) {
        errors.push(
          `'${variableName}' has invalid type. Allowed: ${allowed.join(", ")}; received: ${typeof value}.`
        );
        continue;
      }
    }

    outputByVarName[variableName] = value;
  }

  if (!variableAdditionAllowed && reviewerOutput && typeof reviewerOutput === "object") {
    const knownKeys = new Set();
    for (const varDef of Object.values(schema)) {
      knownKeys.add(String(varDef?.variable_name || ""));
      knownKeys.add(String(varDef?.id || ""));
      knownKeys.add(String(varDef?.variable_name || "").toLowerCase());
    }

    for (const key of Object.keys(reviewerOutput)) {
      if (!knownKeys.has(key)) {
        errors.push(`Unexpected output key '${key}' is not allowed by expected_output_schema.`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, outputByVarName: null, callbackOutput: null };
  }

  const callbackOutput = {};
  for (const varDef of Object.values(schema)) {
    const variableName = String(varDef?.variable_name || "");
    const id = String(varDef?.id || "");
    const value = outputByVarName[variableName];

    callbackOutput[variableName] = value;
    if (id) {
      callbackOutput[id] = value;
    }
  }

  return {
    ok: true,
    errors: [],
    outputByVarName,
    callbackOutput,
  };
};

export const sendHitlCallback = async ({ callback, callbackOutput }) => {
  const headerName = String(callback?.token_header || "").trim();
  const tokenValue = String(callback?.token || "").trim();
  const url = String(callback?.url || "").trim();

  if (!url || !headerName || !tokenValue) {
    throw new Error("Missing callback url/token/token_header in HITL task.");
  }

  const headers = {
    "Content-Type": "application/json",
    [headerName]: tokenValue,
  };

  const body = {
    output: callbackOutput,
  };

  const response = await axios.post(url, body, {
    headers,
    timeout: 20000,
  });

  return {
    status: response.status,
    data: response.data,
  };
};
