export function summarizeCameraStatuses(cameras) {
  const summary = { recording: 0, recordingDisabled: 0, pending: 0, offline: 0, other: 0 };

  cameras.forEach(cam => {
    const state = String(cam?.recording || "").trim().toLowerCase();
    if (!state) { summary.other += 1; return; }

    if (state.includes("recording disabled")) {
      summary.recordingDisabled += 1;
    } else if (state.includes("pending") && (state.includes("no blocks") || state.includes("connecting to storage"))) {
      summary.pending += 1;
    } else if (state.includes("offline") || state.includes("off-line")) {
      summary.offline += 1;
    } else if (state.includes("record")) {
      summary.recording += 1;
    } else {
      summary.other += 1;
    }
  });

  summary.total = cameras.length;
  summary.vmsIssues = (summary.recordingDisabled || 0) + (summary.pending || 0);
  summary.externalIssues = summary.offline || 0;

  return summary;
}