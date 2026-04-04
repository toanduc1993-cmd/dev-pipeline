export const SPRINT_STATUS = {
  PENDING:       'pending',
  WAITING_GATE:  'waiting_gate',
  RUNNING_STEP:  'running_step',
  WAITING_HUMAN: 'waiting_human',
  COMPLETED:     'completed',
  FAILED:        'failed',
};

export const GATE_STATUS = {
  PENDING:          'pending',
  WAITING_APPROVAL: 'waiting_approval',
  APPROVED:         'approved',
  REJECTED:         'rejected',
  AUTO:             'auto',
};

export const TASK_STATUS = {
  PENDING:    'pending',
  RUNNING:    'running',
  VALIDATING: 'validating',
  REVIEWING:  'reviewing',
  PASS:       'pass',
  FAIL:       'fail',
  ESCALATED:  'escalated',
};

export const GATE_DEFINITIONS = {
  0: { title: 'Xac Nhan Yeu Cau',       autoAdvance: false, claudeOutputStep: null },
  1: { title: 'Phe Duyet Kien Truc',     autoAdvance: false, claudeOutputStep: 1 },
  2: { title: 'Phe Duyet Feature Specs', autoAdvance: false, claudeOutputStep: 2 },
  3: { title: 'Phe Duyet Atomic Tasks',  autoAdvance: false, claudeOutputStep: 3 },
  4: { title: 'Agents Hoan Thanh',       autoAdvance: true,  claudeOutputStep: null },
  5: { title: 'Phe Duyet QA Report',     autoAdvance: false, claudeOutputStep: 5 },
  6: { title: 'Final Merge Approval',    autoAdvance: false, claudeOutputStep: null },
};

export const GATE_TO_STEP = {
  0: 1,
  1: 2,
  2: 3,
  3: 4,
  4: 5,
  5: 'gate6',
  6: 'merge',
};

export const CLAUDE_TOOLS = {
  ARCHITECT: [],
  DEVELOPER: ['Read', 'Write', 'Bash', 'TodoWrite', 'TodoRead'],
  REVIEWER:  [],
  QA:        [],
};

export const MAX_PARALLEL_AGENTS = 1;
export const MAX_RETRY_ROUNDS    = 3;
export const TASK_TIMEOUT_MS     = 45 * 60 * 1000;
export const CLAUDE_TIMEOUT_MS   = 10 * 60 * 1000;
