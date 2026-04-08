/**
 * All valid sprint state transitions.
 * Key = current state, Value = array of states it can transition to.
 */
export const TRANSITIONS = {
  'pending':       ['waiting_gate', 'running_step'],
  'waiting_gate':  ['running_step', 'pending'],
  'running_step':  ['waiting_gate', 'failed', 'waiting_human'],
  'waiting_human': ['running_step', 'failed'],
  'completed':     [],
  'failed':        [],
};

export class StateMachine {
  canTransition(from, to) {
    return (TRANSITIONS[from] || []).includes(to);
  }

  assertTransition(from, to) {
    if (!this.canTransition(from, to)) {
      throw new Error(`Invalid transition: ${from} → ${to}`);
    }
  }
}

// Re-export from single source of truth
import { GATE_TO_STEP } from '../../lib/constants.js';
export { GATE_TO_STEP };
