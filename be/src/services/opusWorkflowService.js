/**
 * OPUS V2 workflow metadata service.
 *
 * Fetches the workflow object from the OPUS Reference Workflow API so the BE
 * can enrich incoming off-platform review dispatches with human-readable
 * context: workflow name, upstream node name, variable display names, etc.
 *
 * Uses the same API path as the official opus-aaico Python SDK
 * (GET /reference-workflow/v2/workflow-object/{id}) and authenticates with
 * the same x-service-key header the existing opusApiService.js uses.
 *
 * Results are cached in-process for 1 hour per workflow_id. Cache misses or
 * upstream failures degrade gracefully: callers receive `null` and the rest
 * of the HITL flow proceeds without enrichment.
 */

import axios from "axios";
import dotenv from "dotenv";
import { logError, logInfo } from "../utils/logger.js";

dotenv.config();

const BASE_URL = (process.env.OPUS_BASE_URL || "https://operator.opus.com").replace(/\/$/, "");
const API_KEY = process.env.OPUS_API_KEY;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const cache = new Map(); // workflowId -> { data, fetchedAt }

const client = axios.create({
  baseURL: BASE_URL,
  headers: {
    "x-service-key": API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 10000,
});

/**
 * Fetch a V2 workflow object. Cached for CACHE_TTL_MS per workflow id.
 * Returns the raw workflow object on success, null on failure or missing id.
 */
export const getV2WorkflowObject = async (workflowId) => {
  if (!workflowId || !API_KEY) return null;

  const cached = cache.get(workflowId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const res = await client.get(`/reference-workflow/v2/workflow-object/${workflowId}`);
    cache.set(workflowId, { data: res.data, fetchedAt: Date.now() });
    logInfo("Fetched V2 workflow", {
      workflowId,
      name: res.data?.name,
      nodes: Object.keys(res.data?.nodes || {}).length,
    });
    return res.data;
  } catch (err) {
    logError("Failed to fetch V2 workflow", {
      workflowId,
      status: err.response?.status,
      error: err.response?.data || err.message,
    });
    return null;
  }
};

/**
 * Locate the off-platform review node within a workflow.
 *
 * Identification: handler_class === "human_task" AND properties includes "review".
 * Workflows with multiple review nodes return the first match; the caller can
 * cross-reference against an execution payload if disambiguation is needed.
 */
export const findOffPlatformReviewNode = (workflowObj) => {
  if (!workflowObj?.nodes) return null;
  for (const node of Object.values(workflowObj.nodes)) {
    const isHumanTask = node?.handler_class === "human_task";
    const isReview = Array.isArray(node?.properties) && node.properties.includes("review");
    if (isHumanTask && isReview) return node;
  }
  return null;
};

/**
 * Given a review node, follow its `review_node` mapping to the upstream node
 * that produced the context being reviewed. Returns the upstream node object
 * or null.
 */
export const findUpstreamNodeOf = (workflowObj, reviewNode) => {
  if (!workflowObj?.nodes || !reviewNode) return null;
  const mapping = reviewNode?.mappings?.review_node;
  const originId = mapping?.origin_id;
  if (!originId) return null;
  return workflowObj.nodes[originId] || null;
};

/**
 * Strip a node definition down to fields the FE actually needs to render a
 * review context panel: identity, schema (with display names), no edges or
 * positions or handler internals.
 */
const slimNode = (node) => {
  if (!node) return null;
  return {
    id: node.id,
    name: node.name || "",
    description: node.description || "",
    handler_class: node.handler_class || "",
    type: node.type || node.handler_class || "",
    input_schema: node.input_schema?.schema || {},
    output_schema: node.output_schema?.schema || {},
  };
};

/**
 * Build the metadata bundle attached to a HITL job record on dispatch.
 * Returns null if no workflow context could be resolved.
 */
export const buildWorkflowReviewMeta = (workflowObj) => {
  if (!workflowObj) return null;
  const reviewNode = findOffPlatformReviewNode(workflowObj);
  const upstreamNode = findUpstreamNodeOf(workflowObj, reviewNode);

  return {
    workflow_id: workflowObj.workflow_id || workflowObj.id || "",
    workflow_name: workflowObj.name || "",
    workflow_version: workflowObj.version,
    workflow_description: workflowObj.description || "",
    review_node: slimNode(reviewNode),
    upstream_node: slimNode(upstreamNode),
  };
};

/**
 * Test hook: clear the in-memory cache (used by tests / dev workflows).
 */
export const _clearWorkflowCache = () => cache.clear();
