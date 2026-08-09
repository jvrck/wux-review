import {
  sessionStateSha256,
  type ObservableRoundRecord,
} from "./observable-lifecycle";
import type { ReviewResult, SessionState } from "./types";

interface PreparedObservableFinalization {
  results: {
    claude: ReviewResult;
    codex: ReviewResult;
  };
  sessionState?: SessionState;
}

export async function commitObservableFinalization(input: {
  record: ObservableRoundRecord;
  prepared: PreparedObservableFinalization;
  finalizingDiagnostic: string;
  terminalState: "completed" | "reconciled";
  terminalDiagnostic: string;
  saveRound: (record: ObservableRoundRecord) => Promise<void>;
  saveSession: (reviewId: string, state: SessionState) => Promise<void>;
  afterFinalizingJournal?: () => void | Promise<void>;
  afterSessionWrite?: () => void | Promise<void>;
  afterTerminalJournal?: () => void | Promise<void>;
}): Promise<void> {
  let record: ObservableRoundRecord = {
    ...input.record,
    state: "finalizing",
    updatedAt: new Date().toISOString(),
    diagnostic: input.finalizingDiagnostic,
    finalization: {
      sessionStateSha256: sessionStateSha256(input.prepared.sessionState),
      results: input.prepared.results,
    },
  };
  // Journal the exact finalized results and target session hash before the
  // session write. A retry can then distinguish the prior state from an
  // already-committed target without replaying either reviewer.
  await input.saveRound(record);
  await input.afterFinalizingJournal?.();
  if (input.prepared.sessionState !== undefined) {
    await input.saveSession(record.reviewId, input.prepared.sessionState);
    await input.afterSessionWrite?.();
  }
  record = {
    ...record,
    state: input.terminalState,
    updatedAt: new Date().toISOString(),
    diagnostic: input.terminalDiagnostic,
  };
  await input.saveRound(record);
  await input.afterTerminalJournal?.();
}
