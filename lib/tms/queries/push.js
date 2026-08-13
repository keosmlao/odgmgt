/**
 * Stands in for tms/src/queries/push.js.
 *
 * The real file sends TMS's Firebase push notifications. This app serves the
 * TMS reports read-only and never sends one, but the require graph reaches it —
 * queries/jobs.js requires it at module scope, and dashboard → settings →
 * audit-log → activity-feed reach it too — so carrying the original would drag
 * firebase-admin into the bundle for a feature that is never invoked.
 *
 * Every export is kept so the requires still destructure cleanly. Calling one
 * throws rather than silently doing nothing: if a report path ever does try to
 * push, that is a porting mistake and should be loud, not swallowed.
 */
function notHere(name) {
  return async function unavailable() {
    throw new Error(
      `push.${name}() is not available in odgmgt — this app serves the TMS reports read-only. Send notifications from TMS.`,
    );
  };
}

module.exports = {
  saveToken: notHere("saveToken"),
  deleteToken: notHere("deleteToken"),
  pushToDriver: notHere("pushToDriver"),
  pushToTopic: notHere("pushToTopic"),
  pushDiagnostics: notHere("pushDiagnostics"),
  listPushTargets: notHere("listPushTargets"),
  sendTestPush: notHere("sendTestPush"),
  pushToEmployees: notHere("pushToEmployees"),
  pushHistory: notHere("pushHistory"),
  pushHistoryMarkRead: notHere("pushHistoryMarkRead"),
  remindUnstartedDispatches: notHere("remindUnstartedDispatches"),
};
