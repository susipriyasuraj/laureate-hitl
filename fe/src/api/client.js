import axios from 'axios';

const baseURL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const api = axios.create({ baseURL });

export const getInbox = () => api.get('/inbox').then(r => r.data);

export const openInboxUpdatesStream = (handlers = {}) => {
  const streamBase = baseURL.replace(/\/$/, '');
  const source = new EventSource(`${streamBase}/inbox/stream`);

  if (handlers.onSnapshot) {
    source.addEventListener('snapshot', (event) => {
      handlers.onSnapshot(JSON.parse(event.data));
    });
  }

  if (handlers.onJobUpdate) {
    source.addEventListener('job-update', (event) => {
      handlers.onJobUpdate(JSON.parse(event.data));
    });
  }

  if (handlers.onError) {
    source.onerror = handlers.onError;
  }

  return source;
};

export const triggerScreening = (studentId) =>
  api.post(`/trigger-screening/${studentId}`).then(r => r.data);

export const submitHumanDecision = (threadId, decision, reviewerOutput = null) =>
  api
    .post(`/human-decision/${threadId}`, {
      human_decision: decision,
      reviewer_output: reviewerOutput || undefined,
    })
    .then(r => r.data);

export const getCaseStatus = (studentId) =>
  api.get(`/case-status/${studentId}`).then(r => r.data);

export const getCaseScreening = (studentId) =>
  api.get(`/case-screening/${studentId}`).then(r => r.data);

export const openCaseUpdatesStream = (studentId, handlers = {}) => {
  const streamBase = baseURL.replace(/\/$/, '');
  const source = new EventSource(`${streamBase}/case-updates/${encodeURIComponent(studentId)}/stream`);

  if (handlers.onSnapshot) {
    source.addEventListener('snapshot', (event) => {
      handlers.onSnapshot(JSON.parse(event.data));
    });
  }

  if (handlers.onJobUpdate) {
    source.addEventListener('job-update', (event) => {
      handlers.onJobUpdate(JSON.parse(event.data));
    });
  }

  if (handlers.onError) {
    source.onerror = handlers.onError;
  }

  return source;
};

export const getJobAudit = (jobId) =>
  api.get(`/jobs/${jobId}/audit`).then(r => r.data?.result ?? r.data);

export const resetExcel = () => api.post('/reset').then(r => r.data);
