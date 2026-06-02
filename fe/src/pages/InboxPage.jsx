import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getInbox, openInboxUpdatesStream, resetExcel } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import StatsBar from '../components/StatsBar';
import LoadingSpinner from '../components/LoadingSpinner';

export default function InboxPage() {
  const [cases, setCases]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [resetting, setResetting] = useState(false);
  const navigate = useNavigate();

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getInbox();
      setCases(data);
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Failed to fetch inbox.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleReset = useCallback(async () => {
    Object.keys(sessionStorage)
      .filter(k => k.startsWith('screening_'))
      .forEach(k => sessionStorage.removeItem(k));
    setResetting(true);
    setError(null);
    try {
      await resetExcel();
      await fetchInbox();
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Reset failed. Please try again.');
    } finally {
      setResetting(false);
    }
  }, [fetchInbox]);

  useEffect(() => { fetchInbox(); }, [fetchInbox]);

  // POC mode: rely on backend webhook -> SSE updates instead of frontend polling.
  useEffect(() => {
    const stream = openInboxUpdatesStream({
      onSnapshot: (payload) => {
        setCases(Array.isArray(payload?.cases) ? payload.cases : []);
      },
      onJobUpdate: (payload) => {
        setCases(Array.isArray(payload?.cases) ? payload.cases : []);
      },
      onError: () => {
        // EventSource auto-reconnects; keep UI state as-is.
      },
    });

    return () => stream.close();
  }, []);

  return (
    <div className="min-h-screen bg-[#F5F6F8]">
      {/* ── Header ── */}
      <header className="bg-[#002855] text-white px-6 py-5 shadow-md">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🎓</span>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Laureate Application Screening</h1>
              <p className="text-xs text-[#9CA3AF] mt-0.5">Admissions Review Dashboard</p>
            </div>
          </div>
          <button
            onClick={handleReset}
            disabled={resetting || loading}
            className="
              flex items-center gap-2 px-4 py-2 rounded-lg bg-[#CC0000]
              hover:bg-[#aa0000] text-sm font-medium text-white
              transition-all hover:scale-105 active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          >
            {resetting ? (
              <>
                <span
                  className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white inline-block"
                  style={{ animation: 'spin 0.8s linear infinite' }}
                />
                {' '}
                Resetting…
              </>
            ) : (
              <>⟳ Reset</>
            )}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* ── Error Banner ── */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-300 bg-red-50 p-4 flex items-start gap-3">
            <span className="text-red-500 text-lg flex-shrink-0">✕</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-700">Error loading inbox</p>
              <p className="text-xs text-red-600 mt-0.5">{error}</p>
            </div>
            <button
              onClick={fetchInbox}
              className="text-xs font-medium text-[#1D4ED8] hover:underline flex-shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Stats Bar ── */}
        {!loading && !error && <StatsBar cases={cases} />}

        {/* ── Loading ── */}
        {loading && <LoadingSpinner message="Fetching applications…" />}

        {/* ── Empty State ── */}
        {!loading && !error && cases.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <span className="text-5xl">📭</span>
            <p className="text-base font-semibold text-gray-500">No applications found</p>
            <p className="text-sm text-gray-400">The inbox is empty. Check back later.</p>
          </div>
        )}

        {/* ── Table ── */}
        {!loading && !error && cases.length > 0 && (
          <div className="bg-white rounded-xl border border-[#E2E8F0] shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#E8F0F7] text-[#002855] text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-3 font-medium">Student ID</th>
                    <th className="text-left px-4 py-3 font-medium">Applicant Name</th>
                    <th className="text-left px-4 py-3 font-medium">Request Type</th>
                    <th className="text-left px-4 py-3 font-medium">Case Status</th>
                    <th className="text-left px-4 py-3 font-medium">Application Status</th>
                    <th className="text-left px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((c, i) => (
                    <tr
                      key={c.student_id}
                      onClick={() => {
                        const as = c.application_status?.toLowerCase() || '';
                        const isDone =
                          Boolean(c.is_human_review_ready) ||
                          ['process', 'selected', 'rejected', 'waitlisted', 'incomplete application'].includes(as);
                        navigate(`/case/${c.student_id}`, { state: { mode: isDone ? 'view' : 'screen' } });
                      }}
                      className={`
                        cursor-pointer transition-colors
                        ${i % 2 === 0 ? 'bg-white' : 'bg-[#F5F6F8]'}
                        hover:bg-[#E8F0F7]
                      `}
                    >
                      {/* Student ID */}
                      <td className="px-4 py-3 font-mono text-xs text-[#374151] whitespace-nowrap">
                        {c.student_id}
                      </td>

                      {/* Name */}
                      <td className="px-4 py-3 font-semibold text-[#002855] whitespace-nowrap">
                        {c.applicant_name}
                      </td>

                      {/* Request Type */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge value={c.request_type} kind="request" />
                      </td>

                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge value={c.case_status} kind="application" />
                      </td>

                      {/* Application Status */}
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusBadge value={c.application_status} kind="application" />
                      </td>

                      {/* Action */}
                      <td
                        className="px-4 py-3 whitespace-nowrap"
                        onClick={e => e.stopPropagation()}
                      >
                        {(() => {
                          const as = c.application_status?.toLowerCase() || '';
                          const isDone =
                            Boolean(c.is_human_review_ready) ||
                            ['process', 'selected', 'rejected', 'waitlisted', 'incomplete application'].includes(as);
                          return isDone ? (
                            <button
                              onClick={() => navigate(`/case/${c.student_id}`, { state: { mode: 'view' } })}
                              className="
                                px-3 py-1.5 rounded-lg border border-[#1D4ED8]
                                text-[#1D4ED8] bg-[#E8F0F7] hover:bg-[#d0e2f3]
                                text-xs font-semibold transition-all
                                hover:scale-105 active:scale-95
                              "
                            >
                              View Details →
                            </button>
                          ) : (
                            <button
                              onClick={() => navigate(`/case/${c.student_id}`, { state: { mode: 'screen' } })}
                              className="
                                px-3 py-1.5 rounded-lg bg-[#002855] hover:bg-[#003a7a]
                                text-white text-xs font-semibold transition-all
                                hover:scale-105 active:scale-95
                              "
                            >
                              Start Screening →
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 bg-[#F5F6F8] border-t border-[#E2E8F0] text-xs text-[#9CA3AF]">
              {cases.length} application{cases.length === 1 ? '' : 's'}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
