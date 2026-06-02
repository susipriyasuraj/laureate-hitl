export const cleanupSyntheticOffPlatformJobsController = async (_req, res) => {
  try {
    const removed = removeSyntheticOffPlatformJobs();
    return res.status(200).json({ message: `Removed ${removed} synthetic off-platform jobs.` });
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Cleanup failed" });
  }
};
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import XLSX from "xlsx";
import { fileURLToPath } from "node:url";
import {
  createJob,
  getAllJobs,
  getJobEvents,
  removeSyntheticOffPlatformJobs,
  resetJobs,
  updateJobResult,
} from "../services/jobStore.js";
import {
  executeJob,
  getPresignedUrl,
  getJobResult,
  getJobStatus,
  getWorkflowSchema,
  initiateJob,
} from "../services/opusApiService.js";
import {
  buildAndValidateHitlOutput,
  buildHitlTaskFromWebhook,
  isCanonicalHitlPayload,
  sendHitlCallback,
  validateHitlWebhookPayload,
} from "../services/hitlService.js";
import { logWarn } from "../utils/logger.js";

const WORKFLOW_ID_PRIMARY = process.env.WORKFLOW_ID_PRIMARY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const excelFilePath = path.join(__dirname, "../data/Applicant_Case_Tracker.xlsx");
const activeScreeningByStudent = new Map();
const activeJobWatchers = new Map();

const WORKFLOW_FILE_INPUT_ALIASES = [
  "crm_input_file",
  "fileUrl",
  "file_url",
  "input_file",
  "inputFile",
];

const WORKFLOW_STUDENT_ID_INPUT_ALIASES = [
  "studentId",
  "student_id",
  "student id",
  "studentID",
  "student_id_input",
];

const WEBHOOK_SECRET = process.env.OPUS_OFF_PLATFORM_WEBHOOK_SECRET || "";
const WEBHOOK_SECRET_HEADERS = [
  "x-opus-webhook-secret",
  "x-webhook-secret",
  "x-opus-secret",
];

const ACTION_MAPPINGS = {
  approve: "approve",
  approved: "approve",
  accept: "approve",
  accepted: "approve",
  reject: "reject",
  rejected: "reject",
  deny: "reject",
  denied: "reject",
  waitlist: "waitlist",
  waitlisted: "waitlist",
  raise_insufficiency: "raise_insufficiency",
  raiseinsufficiency: "raise_insufficiency",
  insufficiency: "raise_insufficiency",
  incomplete_application: "raise_insufficiency",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getNormalized = (value) =>
  String(value || "")
    .replace(/[^a-z0-9]+/gi, "_")
    .toLowerCase();

const getRowValue = (row, aliases = []) => {
  const normalizedMap = new Map();
  for (const [key, value] of Object.entries(row || {})) {
    normalizedMap.set(getNormalized(key), value);
  }

  for (const alias of aliases) {
    const normalizedAlias = getNormalized(alias);
    if (normalizedMap.has(normalizedAlias)) {
      return normalizedMap.get(normalizedAlias);
    }
  }

  return "";
};

const readApplicantRowsFromExcel = () => {
  if (!fs.existsSync(excelFilePath)) {
    return [];
  }

  const workbook = XLSX.readFile(excelFilePath);
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) {
    return [];
  }

  const worksheet = workbook.Sheets[firstSheet];
  return XLSX.utils.sheet_to_json(worksheet, { defval: "" });
};

const ensureSeedDataFromExcel = () => {
  const rows = readApplicantRowsFromExcel();
  if (rows.length === 0) {
    return;
  }

  const jobs = getAllJobs();
  const existingStudentIds = new Set(jobs.map((job) => String(job.studentId || "")));

  rows.forEach((row, index) => {
    const studentId = String(
      getRowValue(row, ["Student_ID", "Student ID", "studentId", "student_id"])
    ).trim();

    if (!studentId || existingStudentIds.has(studentId)) {
      return;
    }

    const applicantName = String(
      getRowValue(row, ["Applicant_Name", "Applicant Name", "Name"])
    ).trim();
    const requestType = String(
      getRowValue(row, ["Request_Type", "Request Type"])
    ).trim();
    const applicationStatus = String(
      getRowValue(row, ["Application_Status", "Application Status"])
    ).trim();
    const attachments = String(getRowValue(row, ["Attachments"]) || "").trim();
    const decision = String(getRowValue(row, ["Decision"]) || "").trim();
    const reason = String(getRowValue(row, ["Reason"]) || "").trim();
    const caseStatus = String(getRowValue(row, ["Case_Status", "Case Status"]) || "").trim();
    const email = String(getRowValue(row, ["Email"]) || "").trim();

    createJob({
      // Negative IDs keep seeded records below real Opus execution IDs in sort order.
      jobId: String(-(Date.now() + index)),
      studentId,
      applicant_name: applicantName,
      request_type: requestType || "new",
      application_status: applicationStatus || "Under Review",
      attachments: attachments || "Application file",
      decision,
      reason,
      case_status: caseStatus || "Open",
      email,
      fileName: path.basename(excelFilePath),
      localFilePath: excelFilePath,
      status: "NOT_STARTED",
      isSecondaryWorkflowExecuted: false,
      submittedAt: new Date().toLocaleString("en-GB"),
    });

    existingStudentIds.add(studentId);
  });
};

const extractWorkflowInputSchema = (workflowData) => {
  if (
    workflowData?.jobPayloadSchema &&
    typeof workflowData.jobPayloadSchema === "object"
  ) {
    return workflowData.jobPayloadSchema;
  }

  const inputNodeId = workflowData?.workflow_input_node_id;
  const inputNode = inputNodeId ? workflowData?.nodes?.[inputNodeId] : null;
  const schemaFromNode =
    inputNode?.output_schema?.schema || inputNode?.input_schema?.schema;

  if (schemaFromNode && typeof schemaFromNode === "object") {
    return schemaFromNode;
  }

  return null;
};

const getAliasedInputValue = (inputData = {}, aliases = []) => {
  for (const alias of aliases) {
    const value = inputData[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
};

const isFileLikeWorkflowField = (key, field = {}) => {
  const allowedTypes = Array.isArray(field.allowed_types)
    ? field.allowed_types
    : [];
  const tags = Array.isArray(field.tags) ? field.tags : [];
  const displayName = String(field.display_name || "").toLowerCase();
  const variableName = String(field.variable_name || key || "").toLowerCase();

  const hasFileType = allowedTypes.some((item) => item?.type === "file");
  const hasAllowedFileTag = tags.some(
    (tag) => tag?.variable_name === "allowed_file_types"
  );
  const nameLooksLikeFileField =
    displayName.includes("file") ||
    displayName.includes("data") ||
    variableName.includes("file") ||
    variableName.includes("data");

  return hasFileType || hasAllowedFileTag || nameLooksLikeFileField;
};

const isStudentIdWorkflowField = (key, field = {}) => {
  const displayName = String(field.display_name || "").toLowerCase();
  const variableName = String(field.variable_name || key || "").toLowerCase();

  return (
    displayName.includes("student id") ||
    displayName === "studentid" ||
    variableName.includes("student_id") ||
    variableName.includes("studentid")
  );
};

const buildPayloadInstance = (schema, inputData = {}) => {
  const instance = {};
  const aliasedFileValue = getAliasedInputValue(
    inputData,
    WORKFLOW_FILE_INPUT_ALIASES
  );
  const aliasedStudentIdValue = getAliasedInputValue(
    inputData,
    WORKFLOW_STUDENT_ID_INPUT_ALIASES
  );

  for (const [key, field] of Object.entries(schema)) {
    const normalizedField = field && typeof field === "object" ? field : {};

    let value = inputData[key];
    if (
      value === undefined &&
      aliasedFileValue &&
      isFileLikeWorkflowField(key, normalizedField)
    ) {
      value = aliasedFileValue;
    }
    if (
      value === undefined &&
      aliasedStudentIdValue &&
      isStudentIdWorkflowField(key, normalizedField)
    ) {
      value = aliasedStudentIdValue;
    }
    if (value === undefined) {
      value = normalizedField.value ?? normalizedField.default ?? null;
    }

    instance[key] = { ...normalizedField, value };
  }

  return instance;
};

const toKeyedResult = (payload = {}) => {
  const schema = payload?.jobResultsPayloadSchema;
  if (!schema || typeof schema !== "object") {
    return {};
  }

  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    result[key] = value?.value;
  }
  return result;
};

const isSyntheticOffPlatformStudentId = (value) =>
  String(value || "")
    .toLowerCase()
    .startsWith("off-platform-");

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];

    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        return [raw];
      }
    }

    return raw
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [String(value)];
};

const normalizeAction = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return ACTION_MAPPINGS[normalized] || normalized;
};

const normalizeActions = (value) => {
  const list = parseList(value)
    .flatMap((item) => String(item).split(","))
    .map((item) => normalizeAction(item))
    .filter(Boolean);

  return [...new Set(list)];
};

const parseObject = (value) => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }

  return {};
};

const unwrapScalarValue = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value.find((item) => item !== undefined && item !== null);
    return unwrapScalarValue(first);
  }

  if (typeof value === "object") {
    if (Object.hasOwn(value, "value")) {
      return unwrapScalarValue(value.value);
    }

    if (Object.hasOwn(value, "text")) {
      return unwrapScalarValue(value.text);
    }

    if (Object.hasOwn(value, "label")) {
      return unwrapScalarValue(value.label);
    }
  }

  return null;
};

const toCleanText = (value, fallback = "") => {
  const scalar = unwrapScalarValue(value);
  if (scalar === null || scalar === undefined) {
    return fallback;
  }

  const text = String(scalar).trim();
  return text || fallback;
};

const getCaseInsensitive = (source = {}, key = "") => {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const target = String(key || "").toLowerCase();
  for (const [k, v] of Object.entries(source)) {
    if (String(k).toLowerCase() === target) {
      return v;
    }
  }

  return undefined;
};

const deepFindValue = (source, aliases = []) => {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  for (const alias of aliases) {
    const direct = getCaseInsensitive(source, alias);
    if (direct !== undefined && direct !== null && String(direct).trim() !== "") {
      return direct;
    }
  }

  for (const value of Object.values(source)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const nested = deepFindValue(value, aliases);
    if (nested !== undefined && nested !== null && String(nested).trim() !== "") {
      return nested;
    }
  }

  return undefined;
};

const deriveReviewFlags = (payload = {}) => {
  const completeness =
    parseObject(deepFindValue(payload, ["completeness_flags", "completenessFlags"])) || {};
  const screening =
    parseObject(deepFindValue(payload, ["screening_flags", "screeningFlags"])) || {};

  return {
    completeness_flags: completeness,
    screening_flags: screening,
  };
};

const isPassSignal = (value = "") => {
  const v = String(value).toLowerCase();
  return (
    v.includes("present") ||
    v.includes("verified") ||
    v.includes("selected") ||
    v.includes("above") ||
    v.includes("satisf") ||
    v.includes("eligible")
  );
};

const toUiFlagValue = (value) => {
  const text = String(value || "Not available").trim();
  return `${text} ${isPassSignal(text) ? "✓" : "✗"}`;
};

const isFinalizedDecision = (value) => {
  const normalized = String(value || "").toLowerCase();
  return ["selected", "rejected", "deny", "waitlisted", "incomplete application"].includes(normalized);
};

const resolveCaseStatus = (job = {}) => {
  return (
    job.case_status ||
    job.workflow_output_010zbd01n ||
    (job.status === "COMPLETED" ? "Closed" : "Open")
  );
};

const resolveDecision = (job = {}) => {
  return (
    job.decision ||
    job.application_status ||
    job.workflow_output_p1e47k0wq ||
    job.workflow_output_i7abcyo03 ||
    job.offPlatformDecision ||
    "Pending Review"
  );
};

const resolveApplicantName = (job = {}) => {
  return job.workflow_output_dtnvounmw || job.applicant_name || "Unknown Applicant";
};

const toInboxCase = (job) => ({
  student_id: String(job.studentId || ""),
  applicant_name: resolveApplicantName(job),
  request_type: job.request_type || "New",
  case_status: resolveCaseStatus(job),
  application_status:
    job.status === "COMPLETED" || job.status === "IN PROGRESS" || job.status === "HITL_PENDING"
      ? resolveDecision(job)
      : "Under Review",
  attachments: job.attachments || job.fileName || "Application file",
  is_human_review_ready:
    Boolean(job.isOffPlatformReview) ||
    job.status === "HITL_PENDING" ||
    normalizeActions(job.available_actions).length > 0,
});

const resolveScreeningStatus = (job = {}) => {
  if (job.status === "COMPLETED") return "Completed";
  if (job.status === "IN PROGRESS" || job.status === "IN_PROGRESS") return "In Progress";
  if (
    job.status === "HITL_PENDING" ||
    (Boolean(job.isOffPlatformReview) && normalizeActions(job.available_actions).length > 0)
  )
    return "Pending Human Review";
  return "Not Started";
};

const toCaseInfo = (job) => ({
  student_id: String(job.studentId || ""),
  applicant_name: resolveApplicantName(job),
  request_type: job.request_type || "New",
  screening_status: resolveScreeningStatus(job),
  application_status:
    job.status === "COMPLETED" || job.status === "IN PROGRESS" || job.status === "HITL_PENDING"
      ? resolveDecision(job)
      : "Under Review",
  attachments: job.attachments || job.fileName || "Application file",
});

const toScreeningResult = (job) => {
  const deficiencyList = parseList(job.deficiency_list || job.workflow_output_4mxgvc0db);
  const isCompleted = job.status === "COMPLETED";
  const availableActions = normalizeActions(job.available_actions);
  const decisionLower = String(resolveDecision(job) || "").toLowerCase();
  const pendingHumanReviewSignals = new Set([
    "pending review",
    "under review",
    "process",
    "pending_human_review",
    "pending human review",
  ]);
  const shouldOfferDefaultHumanActions =
    Boolean(job.isOffPlatformReview) &&
    availableActions.length === 0 &&
    (String(job.hitlStatus || "").toUpperCase() === "PENDING" ||
      String(job.status || "").toUpperCase() === "HITL_PENDING" ||
      pendingHumanReviewSignals.has(decisionLower));
  const finalized = isFinalizedDecision(resolveDecision(job)) && availableActions.length === 0;
  const isProcessing =
    ["IN PROGRESS", "PENDING", "IN_PROGRESS"].includes(job.status) &&
    availableActions.length === 0;
  let resolvedAvailableActions = [];

  if (finalized) {
    resolvedAvailableActions = [];
  } else if (availableActions.length > 0) {
    resolvedAvailableActions = availableActions;
  } else if (shouldOfferDefaultHumanActions) {
    resolvedAvailableActions = ["approve", "reject", "waitlist", "raise_insufficiency"];
  } else if (isCompleted) {
    resolvedAvailableActions = ["approve", "reject", "waitlist", "raise_insufficiency"];
  }

  const completenessFlags =
    job.completeness_flags && typeof job.completeness_flags === "object"
      ? job.completeness_flags
      : {
          "ID and Personal Details": toUiFlagValue(job.workflow_output_4f6zv6ezv),
          "Gradesheets and Certificates": toUiFlagValue(job.workflow_output_ga0k4n971),
          "LOR Documents": toUiFlagValue(job.workflow_output_9eyscad0a),
          "Supplemental Documents": toUiFlagValue(job.workflow_output_pook82hn8),
        };

  const screeningFlags =
    job.screening_flags && typeof job.screening_flags === "object"
      ? job.screening_flags
      : {
          "GPA Rule": toUiFlagValue(job.workflow_output_023wrk0az),
          "Work Experience Rule": toUiFlagValue(job.workflow_output_z9kai3q6o),
          "LOR Institution Rule": toUiFlagValue(job.workflow_output_cvrqcxwzu),
          "LOR Recency Rule": toUiFlagValue(job.workflow_output_pexqqlsbt),
        };

  return {
    thread_id: String(job.jobId),
    student_id: String(job.studentId || ""),
    job_status: job.status || "NOT_STARTED",
    is_processing: isProcessing,
    decision: resolveDecision(job),
    flagged_or_verified:
      job.workflow_output_izvdziwj0 || job.workflow_output_akfo7j55t || (isCompleted ? "Flagged" : "In Progress"),
    case_status: resolveCaseStatus(job),
    completeness_flags: completenessFlags,
    screening_flags: screeningFlags,
    deficiency_list: deficiencyList,
    reason: job.reason || deficiencyList.join("; ") || "No deficiencies.",
    available_actions: resolvedAvailableActions,
    expected_output_schema: job.hitlExpectedOutputSchema?.schema || null,
    hitl_status: job.hitlStatus || null,
    last_updated: new Date().toISOString(),
  };
};

const hasScreeningData = (job = {}) => {
  const status = String(job.status || "").toUpperCase();
  if (["IN PROGRESS", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"].includes(status)) {
    return true;
  }

  if (normalizeActions(job.available_actions).length > 0) {
    return true;
  }

  return Object.keys(job).some((key) => key.startsWith("workflow_output_"));
};

const buildRealtimeCasePayload = (job) => ({
  case_info: toCaseInfo(job),
  screening_result: hasScreeningData(job) ? toScreeningResult(job) : null,
});

const toHumanDecisionResult = (decisionAction, existingJob = {}) => {
  const mapping = {
    approve: {
      decision: "Selected",
      application_status: "Selected",
      case_status: "Closed",
    },
    reject: {
      decision: "Deny",
      application_status: "Rejected",
      case_status: "Closed",
    },
    waitlist: {
      decision: "Waitlisted",
      application_status: "Waitlisted",
      case_status: "Open",
    },
    raise_insufficiency: {
      decision: "Incomplete Application",
      application_status: "Incomplete Application",
      case_status: "Open",
    },
  };

  return mapping[decisionAction] || {
    decision: resolveDecision(existingJob),
    application_status: resolveDecision(existingJob),
    case_status: resolveCaseStatus(existingJob),
  };
};

const findLatestJobByStudentId = (studentId) => {
  const jobs = getAllJobs();

  const getSortWeight = (job = {}) => {
    const offPlatformLinkedAt = Date.parse(job?.offPlatformLinkedAt || "");
    if (Number.isFinite(offPlatformLinkedAt)) {
      return offPlatformLinkedAt;
    }

    const submittedTime = Date.parse(job?.submittedAt || "");
    if (Number.isFinite(submittedTime)) {
      return submittedTime;
    }

    const numericJobId = Number(job?.jobId);
    if (Number.isFinite(numericJobId)) {
      return numericJobId;
    }

    return 0;
  };

  const getPriorityScore = (job = {}) => {
    const actions = normalizeActions(job.available_actions);
    const hitlPending =
      String(job.status || "").toUpperCase() === "HITL_PENDING" ||
      String(job.hitlStatus || "").toUpperCase() === "PENDING";
    if (actions.length > 0 || hitlPending) {
      return 2;
    }

    const inProgress = ["IN PROGRESS", "IN_PROGRESS", "PENDING"].includes(
      String(job.status || "").toUpperCase()
    );
    if (inProgress) {
      return 1;
    }

    return 0;
  };

  const matches = jobs
    .filter((job) => String(job.studentId) === String(studentId))
    .sort((a, b) => {
      const byPriority = getPriorityScore(b) - getPriorityScore(a);
      if (byPriority !== 0) {
        return byPriority;
      }
      return getSortWeight(b) - getSortWeight(a);
    });

  return matches[0] || null;
};

const isWebhookRequestAuthorized = (req) => {
  if (!WEBHOOK_SECRET) {
    return true;
  }

  for (const headerName of WEBHOOK_SECRET_HEADERS) {
    const incoming = req.headers?.[headerName];
    if (incoming && String(incoming) === WEBHOOK_SECRET) {
      return true;
    }
  }

  const authHeader = String(req.headers?.authorization || "");
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token === WEBHOOK_SECRET) {
      return true;
    }
  }

  return false;
};

const buildOffPlatformReviewJob = (payload = {}) => {
  const offPlatformThreadId =
    deepFindValue(payload, [
      "thread_id",
      "threadId",
      "jobExecutionId",
      "job_execution_id",
      "execution_id",
      "id",
    ]) ||
    `${Date.now()}`;

  const studentId =
    deepFindValue(payload, [
      "student_id",
      "studentId",
      "candidate_id",
      "applicant_id",
    ]) || `off-platform-${offPlatformThreadId}`;

  const applicantName =
    deepFindValue(payload, ["applicant_name", "applicantName", "candidate_name", "name"]) ||
    `Applicant ${studentId}`;

  const requestType =
    deepFindValue(payload, ["request_type", "requestType", "type"]) || "Off Platform Review";

  const decision =
    deepFindValue(payload, ["decision", "application_status", "current_decision"]) ||
    "Pending Review";

  const caseStatus =
    deepFindValue(payload, ["case_status", "caseStatus"]) || "Open";

  const reason =
    deepFindValue(payload, ["reason", "review_reason", "notes", "comment"]) || "Pending human review";

  const availableActions = normalizeActions(
    deepFindValue(payload, ["available_actions", "availableActions", "actions", "allowed_actions"])
  );

  const callbackUrl =
    deepFindValue(payload, ["callback_url", "callbackUrl", "resume_url", "resumeUrl"]) || "";
  const callbackMethod =
    deepFindValue(payload, ["callback_method", "callbackMethod", "method"]) || "POST";
  const callbackHeaders =
    parseObject(deepFindValue(payload, ["callback_headers", "callbackHeaders"])) || {};

  const flags = deriveReviewFlags(payload);

  const normalizedThreadId =
    toCleanText(offPlatformThreadId, "") || `off-platform-${Date.now()}`;
  const normalizedStudentId =
    toCleanText(studentId, "") || `off-platform-${normalizedThreadId}`;
  const normalizedApplicantName =
    toCleanText(applicantName, "") || `Applicant ${normalizedStudentId}`;
  const normalizedRequestType =
    toCleanText(requestType, "Off Platform Review") || "Off Platform Review";
  const normalizedDecision = toCleanText(decision, "Pending Review") || "Pending Review";
  const normalizedCaseStatus = toCleanText(caseStatus, "Open") || "Open";
  const normalizedReason = toCleanText(reason, "Pending human review") || "Pending human review";
  const normalizedCallbackUrl = toCleanText(callbackUrl, "");
  const normalizedCallbackMethod = toCleanText(callbackMethod, "POST") || "POST";
  const pendingHumanReviewSignals = new Set([
    "pending review",
    "under review",
    "process",
    "pending_human_review",
    "pending human review",
  ]);

  let resolvedAvailableActions = [];
  if (availableActions.length > 0) {
    resolvedAvailableActions = availableActions;
  } else if (pendingHumanReviewSignals.has(String(normalizedDecision || "").toLowerCase())) {
    resolvedAvailableActions = ["approve", "reject", "waitlist", "raise_insufficiency"];
  }

  const resolvedStatus = resolvedAvailableActions.length > 0 ? "HITL_PENDING" : "COMPLETED";

  return {
    offPlatformThreadId: normalizedThreadId,
    studentId: normalizedStudentId,
    applicant_name: normalizedApplicantName,
    request_type: normalizedRequestType,
    application_status: normalizedDecision,
    case_status: normalizedCaseStatus,
    decision: normalizedDecision,
    reason: normalizedReason,
    status: resolvedStatus,
    available_actions: resolvedAvailableActions,
    deficiency_list: parseList(
      deepFindValue(payload, ["deficiency_list", "deficiencyList", "deficiencies"])
    ),
    attachments:
      toCleanText(deepFindValue(payload, ["attachments", "documents", "file_name", "fileName"]), "") ||
      "Off-platform submission",
    isOffPlatformReview: true,
    offPlatformCallbackUrl: normalizedCallbackUrl,
    offPlatformCallbackMethod: normalizedCallbackMethod.toUpperCase(),
    offPlatformCallbackHeaders: callbackHeaders,
    offPlatformPayload: payload,
    submittedAt: new Date().toLocaleString("en-GB"),
    ...flags,
  };
};

/**
 * Extract a purely numeric Opus jobExecutionId from the webhook payload.
 * Opus numeric IDs are 4+ digit integers (e.g. 65204).  UUIDs contain hyphens
 * and are therefore excluded.  Returns null when nothing numeric is found.
 */
const extractNumericJobId = (payload = {}) => {
  const keys = [
    "jobExecutionId",
    "job_execution_id",
    "executionId",
    "execution_id",
    "thread_id",
    "threadId",
  ];
  for (const key of keys) {
    const val = deepFindValue(payload, [key]);
    const text = toCleanText(val, "");
    if (/^\d{4,}$/.test(text)) return text;
  }
  return null;
};

const findBestCandidateForOffPlatformReview = (jobs = []) => {
  const candidates = jobs
    .filter((job) => {
      if (job.isOffPlatformReview) return false;
      if (isSyntheticOffPlatformStudentId(job.studentId)) return false;

      const status = String(job.status || "").toUpperCase();
      const decision = String(resolveDecision(job) || "").toLowerCase();
      const hasActions = normalizeActions(job.available_actions).length > 0;

      // A completed screening waiting for human-review webhook usually lands here.
      return (
        status === "COMPLETED" &&
        !hasActions &&
        ["pending review", "process", "under review", ""].includes(decision)
      );
    })
    .sort((a, b) => Number(b.jobId || 0) - Number(a.jobId || 0));

  return candidates[0] || null;
};

const buildOffPlatformMergePayload = (normalized, payload, linkage = {}) => ({
  isOffPlatformReview: true,
  available_actions: normalized.available_actions,
  offPlatformThreadId: normalized.offPlatformThreadId,
  offPlatformCallbackUrl: normalized.offPlatformCallbackUrl,
  offPlatformCallbackMethod: normalized.offPlatformCallbackMethod,
  offPlatformCallbackHeaders: normalized.offPlatformCallbackHeaders,
  offPlatformPayload: payload,
  offPlatformLinkageMethod: linkage.method || "unknown",
  offPlatformLinkageMatchedBy: linkage.matchedBy || "unknown",
  offPlatformLinkedAt: new Date().toISOString(),
  decision: normalized.decision,
  application_status: normalized.application_status,
  case_status: normalized.case_status,
  reason: normalized.reason,
  ...(normalized.deficiency_list?.length ? { deficiency_list: normalized.deficiency_list } : {}),
});

const tryMergeIntoJob = (job, normalized, payload, linkage) => {
  if (!job) return null;
  const updated = updateJobResult(
    String(job.jobId),
    buildOffPlatformMergePayload(normalized, payload, linkage)
  );
  return {
    job: updated,
    linkage_method: linkage?.method || "unknown",
    linkage_matched_by: linkage?.matchedBy || "unknown",
    linked_job_id: String(updated.jobId || ""),
  };
};

const upsertOffPlatformJob = (payload = {}) => {
  const normalized = buildOffPlatformReviewJob(payload);
  const jobs = getAllJobs();

  // 1. Try to match by numeric Opus jobExecutionId so we update the REAL student
  //    job record (which already has all screening / workflow_output_* data) instead
  //    of creating a phantom off-platform entry.
  const opusJobId = extractNumericJobId(payload);
  if (opusJobId) {
    const existingByJobId = jobs.find((j) => String(j.jobId) === opusJobId);
    const mergedByJobId = tryMergeIntoJob(existingByJobId, normalized, payload, {
      method: "job_id",
      matchedBy: opusJobId,
    });
    if (mergedByJobId) return mergedByJobId;
  }

  // 2. Idempotency: re-processing the same webhook UUID should update, not duplicate.
  const existingByThread = jobs.find(
    (job) => String(job.offPlatformThreadId || "") === String(normalized.offPlatformThreadId)
  );

  if (existingByThread) {
    return tryMergeIntoJob(existingByThread, normalized, payload, {
      method: "thread_id",
      matchedBy: String(normalized.offPlatformThreadId || ""),
    });
  }

  // 3. If webhook carries a real student id, merge into that student's latest real job.
  if (!isSyntheticOffPlatformStudentId(normalized.studentId)) {
    const existingByStudent = jobs
      .filter((j) => String(j.studentId || "") === String(normalized.studentId))
      .sort((a, b) => Number(b.jobId || 0) - Number(a.jobId || 0))[0];

    const mergedByStudent = tryMergeIntoJob(existingByStudent, normalized, payload, {
      method: "student_id",
      matchedBy: String(normalized.studentId || ""),
    });
    if (mergedByStudent) return mergedByStudent;
  }

  // 4. Heuristic fallback for Opus payloads that omit student id and numeric job id.
  const candidate = findBestCandidateForOffPlatformReview(jobs);
  const mergedByCandidate = tryMergeIntoJob(candidate, normalized, payload, {
    method: "heuristic_latest_pending_review",
    matchedBy: String(candidate?.jobId || ""),
  });
  if (mergedByCandidate) return mergedByCandidate;

  // 5. Last fallback: Opus sent nothing correlatable – create a synthetic entry.
  const newJobId = String(Date.now());
  const created = createJob({
    ...normalized,
    offPlatformLinkageMethod: "synthetic_fallback",
    offPlatformLinkageMatchedBy: String(normalized.offPlatformThreadId || ""),
    offPlatformLinkedAt: new Date().toISOString(),
    jobId: newJobId,
    groupId: null,
    isSecondaryWorkflowExecuted: false,
  });

  return {
    job: created,
    linkage_method: "synthetic_fallback",
    linkage_matched_by: String(normalized.offPlatformThreadId || ""),
    linked_job_id: String(created.jobId || ""),
  };
};

const notifyOffPlatformDecision = async (job, action, mappedDecision) => {
  const callbackUrl = String(job.offPlatformCallbackUrl || "").trim();
  if (!callbackUrl) {
    return;
  }

  const callbackHeaders = {
    "Content-Type": "application/json",
    ...parseObject(job.offPlatformCallbackHeaders),
  };

  const body = {
    thread_id: String(job.offPlatformThreadId || job.jobId),
    human_decision: action,
    decision: mappedDecision.decision,
    application_status: mappedDecision.application_status,
    case_status: mappedDecision.case_status,
    student_id: String(job.studentId || ""),
  };

  await axios({
    method: String(job.offPlatformCallbackMethod || "POST").toLowerCase(),
    url: callbackUrl,
    headers: callbackHeaders,
    data: body,
    timeout: 20000,
  });
};

const waitForJobCompletion = async (jobExecutionId) => {
  const maxAttempts = 120;
  const intervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const statusPayload = await getJobStatus(jobExecutionId);
    const status = statusPayload?.status;

    if (status === "COMPLETED") {
      const resultPayload = await getJobResult(jobExecutionId);
      return { status, result: toKeyedResult(resultPayload) };
    }

    if (["FAILED", "CANCELLED"].includes(status)) {
      throw new Error(`Job did not complete successfully. Last status: ${status}`);
    }

    await sleep(intervalMs);
  }

  throw new Error("Timed out waiting for Opus workflow completion");
};

const watchJobCompletion = (jobExecutionId) => {
  if (activeJobWatchers.has(jobExecutionId)) {
    return;
  }

  const watchPromise = (async () => {
    try {
      const { status, result } = await waitForJobCompletion(jobExecutionId);
      updateJobResult(String(jobExecutionId), { status, ...result });
    } catch (error) {
      updateJobResult(String(jobExecutionId), {
        status: "FAILED",
        failure_reason: error.message || "Job monitoring failed",
      });
    } finally {
      activeJobWatchers.delete(jobExecutionId);
    }
  })();

  activeJobWatchers.set(jobExecutionId, watchPromise);
};

const uploadLocalExcelToOpus = async (localPath) => {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error("Local Excel file was not found in backend data folder");
  }

  const extension = path.extname(localPath).replace(".", "").toLowerCase() || "xlsx";
  const { presignedUrl, fileUrl } = await getPresignedUrl(extension);

  const fileBuffer = fs.readFileSync(localPath);
  await axios.put(presignedUrl, fileBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": fileBuffer.length,
    },
  });

  return fileUrl;
};

const runPrimaryWorkflowForStudent = async (studentId) => {
  ensureSeedDataFromExcel();
  let existing = findLatestJobByStudentId(studentId);
  if (!existing) {
    throw new Error("Student was not found in Excel metadata");
  }

  const hasPendingHumanReview =
    (Boolean(existing.isOffPlatformReview) || String(existing.status || "") === "HITL_PENDING") &&
    normalizeActions(existing.available_actions).length > 0;

  if (hasPendingHumanReview) {
    return existing;
  }

  // If job is already in progress or completed, return it (idempotency)
  if (["IN PROGRESS", "COMPLETED"].includes(existing.status)) {
    return existing;
  }

  if (!existing.fileUrl) {
    const localSourcePath = existing.localFilePath || excelFilePath;
    const fileUrl = await uploadLocalExcelToOpus(localSourcePath);
    existing = updateJobResult(String(existing.jobId), {
      fileUrl,
      fileName: path.basename(localSourcePath),
    });
  }

  const workflowData = await getWorkflowSchema(WORKFLOW_ID_PRIMARY);
  const schema = extractWorkflowInputSchema(workflowData);
  if (!schema) {
    throw new Error("Workflow input schema was not found in Opus response");
  }

  const payloadInstance = buildPayloadInstance(schema, {
    studentId: String(studentId),
    crm_input_file: existing.fileUrl,
  });

  const { jobExecutionId } = await initiateJob(
    WORKFLOW_ID_PRIMARY,
    "UI Triggered Screening",
    `Screening for student ${studentId}`
  );

  createJob({
    jobId: String(jobExecutionId),
    isSecondaryWorkflowExecuted: false,
    fileUrl: existing.fileUrl,
    fileName: existing.fileName,
    localFilePath: existing.localFilePath,
    applicant_name: existing.applicant_name,
    request_type: existing.request_type,
    attachments: existing.attachments,
    email: existing.email,
    decision: existing.decision,
    reason: existing.reason,
    case_status: existing.case_status,
    studentId: String(studentId),
    groupId: existing.groupId || null,
    status: "IN PROGRESS",
    submittedAt: new Date().toLocaleString("en-GB"),
  });

  await executeJob(jobExecutionId, payloadInstance);
  watchJobCompletion(String(jobExecutionId));

  return getAllJobs().find((item) => String(item.jobId) === String(jobExecutionId));
};

export const getInboxController = async (_req, res) => {
  try {
    res.status(200).json(getInboxCasesSnapshot());
  } catch (error) {
    res.status(500).json({ detail: error.message || "Failed to fetch inbox" });
  }
};

const getInboxCasesSnapshot = () => {
  ensureSeedDataFromExcel();
  const jobs = getAllJobs().sort((a, b) => Number(b.jobId) - Number(a.jobId));

  const realThreadIds = new Set(
    jobs
      .filter(
        (job) =>
          String(job.offPlatformThreadId || "").trim() &&
          !isSyntheticOffPlatformStudentId(job.studentId)
      )
      .map((job) => String(job.offPlatformThreadId))
  );

  const dedupedJobs = jobs.filter((job) => {
    const threadId = String(job.offPlatformThreadId || "").trim();
    if (!threadId) return true;
    if (!isSyntheticOffPlatformStudentId(job.studentId)) return true;
    return !realThreadIds.has(threadId);
  });

  const seenStudentIds = new Set();
  const uniqueByStudent = [];

  for (const job of dedupedJobs) {
    const studentId = String(job.studentId || "").trim();
    if (!studentId || seenStudentIds.has(studentId)) {
      continue;
    }
    seenStudentIds.add(studentId);
    uniqueByStudent.push(job);
  }

  return uniqueByStudent.map(toInboxCase);
};

export const streamInboxUpdatesController = async (_req, res) => {
  ensureSeedDataFromExcel();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const writeEvent = (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendSnapshot = () => {
    writeEvent("snapshot", {
      cases: getInboxCasesSnapshot(),
    });
  };

  sendSnapshot();

  const events = getJobEvents();
  const onJobUpdate = (eventPayload) => {
    writeEvent("job-update", {
      type: eventPayload?.type || "updated",
      cases: getInboxCasesSnapshot(),
    });
  };

  events.on("job:update", onJobUpdate);

  const heartbeat = setInterval(() => {
    writeEvent("heartbeat", { ts: Date.now() });
  }, 15000);

  res.req.on("close", () => {
    clearInterval(heartbeat);
    events.off("job:update", onJobUpdate);
    res.end();
  });
};

export const getCaseStatusController = async (req, res) => {
  try {
    ensureSeedDataFromExcel();
    const job = findLatestJobByStudentId(req.params.studentId);
    if (!job) {
      return res.status(404).json({ detail: "Case not found" });
    }

    return res.status(200).json(toCaseInfo(job));
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Failed to fetch case" });
  }
};

export const getLatestScreeningResultController = async (req, res) => {
  try {
    ensureSeedDataFromExcel();
    const studentId = String(req.params.studentId || "").trim();
    const job = findLatestJobByStudentId(studentId);

    if (!job) {
      return res.status(404).json({ detail: "Case not found" });
    }

    return res.status(200).json(buildRealtimeCasePayload(job));
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Failed to fetch screening result" });
  }
};

export const streamCaseUpdatesController = async (req, res) => {
  ensureSeedDataFromExcel();

  const studentId = String(req.params.studentId || "").trim();
  if (!studentId) {
    return res.status(400).json({ detail: "studentId is required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const writeEvent = (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendSnapshot = () => {
    const latestJob = findLatestJobByStudentId(studentId);
    if (!latestJob) {
      writeEvent("snapshot", { student_id: studentId, case_info: null, screening_result: null });
      return;
    }

    writeEvent("snapshot", buildRealtimeCasePayload(latestJob));
  };

  sendSnapshot();

  const events = getJobEvents();
  const onJobUpdate = (eventPayload) => {
    const updatedJob = eventPayload?.job;
    if (!updatedJob) {
      return;
    }

    if (String(updatedJob.studentId || "") !== studentId) {
      return;
    }

    writeEvent("job-update", {
      type: eventPayload?.type || "updated",
      ...buildRealtimeCasePayload(updatedJob),
    });
  };

  events.on("job:update", onJobUpdate);

  const heartbeat = setInterval(() => {
    writeEvent("heartbeat", { ts: Date.now() });
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    events.off("job:update", onJobUpdate);
    res.end();
  });
};

export const triggerScreeningController = async (req, res) => {
  const studentId = String(req.params.studentId || "").trim();
  try {
    ensureSeedDataFromExcel();

    if (activeScreeningByStudent.has(studentId)) {
      const inFlight = await activeScreeningByStudent.get(studentId);
      return res.status(200).json(toScreeningResult(inFlight));
    }

    const runPromise = (async () => {
      return runPrimaryWorkflowForStudent(studentId);
    })();

    activeScreeningByStudent.set(studentId, runPromise);
    const result = await runPromise;
    activeScreeningByStudent.delete(studentId);

    return res.status(200).json(toScreeningResult(result));
  } catch (error) {
    activeScreeningByStudent.delete(studentId);
    return res.status(500).json({ detail: error.message || "Screening failed" });
  }
};

export const offPlatformReviewWebhookController = async (req, res) => {
  try {
    if (!isWebhookRequestAuthorized(req)) {
      return res.status(401).json({ detail: "Unauthorized webhook request" });
    }

    const payload = req.body || {};

    if (isCanonicalHitlPayload(payload)) {
      const validation = validateHitlWebhookPayload(payload);
      if (!validation.ok) {
        // Log schema warnings but never reject with 400 — Opus marks the node
        // as DISPATCH_FAILED on any 4xx, which permanently breaks the workflow.
        // We accept and process the payload; warnings are for debugging only.
        logWarn("HITL webhook payload has schema warnings (processing anyway)", {
          execution_id: payload.execution_id,
          errors: validation.errors,
        });
      }

      const task = buildHitlTaskFromWebhook(payload);
      const existing = getAllJobs().find(
        (item) => String(item.jobId || "") === String(task.jobId)
      );

      const saved = existing
        ? updateJobResult(String(task.jobId), {
            ...task,
            hitlAuditLog: [
              ...(Array.isArray(existing.hitlAuditLog) ? existing.hitlAuditLog : []),
              {
                type: "webhook_received",
                at: new Date().toISOString(),
                execution_id: String(payload.execution_id),
                workflow_id: String(payload.workflow_id),
              },
            ],
          })
        : createJob(task);

      return res.status(202).json({
        message: "HITL task accepted",
        thread_id: String(saved.jobId),
        execution_id: String(saved.hitlExecutionId || saved.jobId),
        student_id: String(saved.studentId || ""),
        available_actions: normalizeActions(saved.available_actions),
        hitl_status: String(saved.hitlStatus || "PENDING"),
      });
    }

    const { job, linkage_method, linkage_matched_by, linked_job_id } = upsertOffPlatformJob(payload);

    return res.status(202).json({
      message: "Off Platform Review task accepted",
      thread_id: String(job.jobId),
      student_id: String(job.studentId || ""),
      available_actions: normalizeActions(job.available_actions),
      linkage_method,
      linkage_matched_by,
      linked_job_id,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ detail: error.message || "Failed to process Off Platform Review webhook" });
  }
};

export const getPendingOffPlatformReviewController = async (_req, res) => {
  try {
    ensureSeedDataFromExcel();

    const records = getAllJobs()
      .filter(
        (job) =>
          Boolean(job.isOffPlatformReview) &&
          normalizeActions(job.available_actions).length > 0
      )
      .sort((a, b) => {
        const aTs = Date.parse(a.offPlatformLinkedAt || a.submittedAt || "") || 0;
        const bTs = Date.parse(b.offPlatformLinkedAt || b.submittedAt || "") || 0;
        return bTs - aTs;
      })
      .map((job) => ({
        thread_id: String(job.jobId || ""),
        execution_id: String(job.hitlExecutionId || job.jobId || ""),
        student_id: String(job.studentId || ""),
        applicant_name: resolveApplicantName(job),
        case_status: resolveCaseStatus(job),
        decision: resolveDecision(job),
        available_actions: normalizeActions(job.available_actions),
        hitl_status: String(job.hitlStatus || "PENDING"),
        submitted_at: String(job.submittedAt || ""),
      }));

    return res.status(200).json({ count: records.length, records });
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Failed to fetch pending HITL tasks" });
  }
};

export const getOffPlatformReviewDetailController = async (req, res) => {
  try {
    ensureSeedDataFromExcel();

    const threadId = String(req.params.threadId || "").trim();
    const job = getAllJobs().find((item) => String(item.jobId || "") === threadId);

    if (!job) {
      return res.status(404).json({ detail: "HITL task not found" });
    }

    return res.status(200).json({
      thread_id: String(job.jobId || ""),
      execution_id: String(job.hitlExecutionId || job.jobId || ""),
      workflow_id: String(job.hitlWorkflowId || ""),
      workflow_name: String(job.hitlWorkflowName || ""),
      node_execution_id: String(job.hitlNodeExecutionId || ""),
      student_id: String(job.studentId || ""),
      applicant_name: resolveApplicantName(job),
      case_status: resolveCaseStatus(job),
      decision: resolveDecision(job),
      available_actions: normalizeActions(job.available_actions),
      input_context: job.hitlInputs || {},
      node_output: job.hitlNodeOutput || {},
      expected_output_schema: job.hitlExpectedOutputSchema || null,
      hitl_status: String(job.hitlStatus || "PENDING"),
      audit_log: Array.isArray(job.hitlAuditLog) ? job.hitlAuditLog : [],
    });
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Failed to fetch HITL task detail" });
  }
};

export const getOffPlatformReviewAuditController = async (req, res) => {
  try {
    ensureSeedDataFromExcel();
    const requestedLimit = Number(req.query?.limit || 20);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
      : 20;

    const records = getAllJobs()
      .filter(
        (job) =>
          Boolean(job.isOffPlatformReview) ||
          Boolean(String(job.offPlatformThreadId || "").trim()) ||
          Boolean(String(job.offPlatformLinkageMethod || "").trim())
      )
      .sort((a, b) => {
        const aTs = Date.parse(a.offPlatformLinkedAt || "") || Number(a.jobId || 0);
        const bTs = Date.parse(b.offPlatformLinkedAt || "") || Number(b.jobId || 0);
        return bTs - aTs;
      })
      .slice(0, limit)
      .map((job) => ({
        job_id: String(job.jobId || ""),
        student_id: String(job.studentId || ""),
        applicant_name: resolveApplicantName(job),
        is_synthetic_student: isSyntheticOffPlatformStudentId(job.studentId),
        off_platform_thread_id: String(job.offPlatformThreadId || ""),
        linkage_method: String(job.offPlatformLinkageMethod || ""),
        linkage_matched_by: String(job.offPlatformLinkageMatchedBy || ""),
        linked_at: String(job.offPlatformLinkedAt || ""),
        available_actions: normalizeActions(job.available_actions),
        decision: resolveDecision(job),
        case_status: resolveCaseStatus(job),
        status: String(job.status || ""),
      }));

    return res.status(200).json({ count: records.length, records });
  } catch (error) {
    return res
      .status(500)
      .json({ detail: error.message || "Failed to fetch Off Platform Review audit" });
  }
};

export const submitHumanDecisionController = async (req, res) => {
  try {
    ensureSeedDataFromExcel();
    const threadId = String(req.params.threadId);
    const action = req.body?.human_decision;

    const job = getAllJobs().find((item) => String(item.jobId) === threadId);
    if (!job) {
      return res.status(404).json({ detail: "Screening thread not found" });
    }

    const reviewerOutput =
      req.body?.reviewer_output && typeof req.body.reviewer_output === "object"
        ? req.body.reviewer_output
        : {};

    const mapped = toHumanDecisionResult(action, job);

    if (job.isOffPlatformReview && job.hitlCallback?.url) {
      const validation = buildAndValidateHitlOutput({
        expectedOutputSchema: job.hitlExpectedOutputSchema || {},
        reviewerOutput,
        humanDecision: action,
        hitlInputs: job.hitlInputs || {},
        hitlNodeOutput: job.hitlNodeOutput || {},
      });

      if (!validation.ok) {
        return res.status(400).json({
          detail: "Reviewer output does not match expected_output_schema",
          errors: validation.errors,
        });
      }

      const callbackResult = await sendHitlCallback({
        callback: job.hitlCallback,
        callbackOutput: validation.callbackOutput,
      });

      const updatedHitlAudit = [
        ...(Array.isArray(job.hitlAuditLog) ? job.hitlAuditLog : []),
        {
          type: "review_submitted",
          at: new Date().toISOString(),
          human_decision: action,
          reviewer_output: reviewerOutput,
          callback_output: validation.callbackOutput,
          callback_status: callbackResult.status,
        },
      ];

      const updated = updateJobResult(threadId, {
        decision: mapped.decision,
        application_status: mapped.application_status,
        case_status: mapped.case_status,
        workflow_output_p1e47k0wq: mapped.application_status,
        workflow_output_i7abcyo03: mapped.application_status,
        available_actions: [],
        hitlStatus: "SUBMITTED",
        hitlLastOutput: validation.outputByVarName,
        hitlLastCallbackPayload: { output: validation.callbackOutput },
        hitlLastCallbackStatus: callbackResult.status,
        hitlAuditLog: updatedHitlAudit,
        offPlatformDecisionSubmittedAt: new Date().toISOString(),
      });

      return res.status(200).json({
        decision: mapped.decision,
        application_status: mapped.application_status,
        case_status: mapped.case_status,
        thread_id: threadId,
        student_id: String(updated.studentId || ""),
        hitl_status: "SUBMITTED",
        callback_status: callbackResult.status,
      });
    }

    if (job.isOffPlatformReview) {
      await notifyOffPlatformDecision(job, action, mapped);
    }

    const updated = updateJobResult(threadId, {
      decision: mapped.decision,
      application_status: mapped.application_status,
      case_status: mapped.case_status,
      workflow_output_p1e47k0wq: mapped.application_status,
      workflow_output_i7abcyo03: mapped.application_status,
      available_actions: [],
      offPlatformDecisionSubmittedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      decision: mapped.decision,
      application_status: mapped.application_status,
      case_status: mapped.case_status,
      thread_id: threadId,
      student_id: String(updated.studentId || ""),
    });
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Decision submission failed" });
  }
};

export const resetJobsController = async (_req, res) => {
  try {
    resetJobs();
    return res.status(200).json({ message: "Jobs reset successful" });
  } catch (error) {
    return res.status(500).json({ detail: error.message || "Reset failed" });
  }
};
