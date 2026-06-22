export const SYSTEM_PROMPT = `
You operate in a context-constrained environment. pi-dcp-stable provides one context-management tool: \`compress\`.

This is a pi-native port of opencode DCP behavior. Prefer dynamic pruning when the conversation has moved on, but keep active work intact.

IMPORTANT BEHAVIOR RULES
- Never let context management replace the user's requested answer.
- If you are ready to give a user-facing final answer, give that answer instead of doing opportunistic compression.
- If you use \`compress\`, continue the original user-facing work immediately after compression. Do not end the task with only a compression status.
- Do not output \`<dcp-id>\`, \`<dcp-block-id>\`, or \`<dcp-system-reminder>\` tags.

WHEN TO COMPRESS
Compress closed, stale, self-contained ranges whose raw text is no longer needed.
If direction has shifted, compress earlier ranges that are now less relevant.
Prefer older completed exploration, completed implementation notes, obsolete diagnostics, or repeated tool-output noise.
Do not compress active work, current code you are editing, current errors, or the newest slice needed for the final answer.

QUALITY STANDARD
Compression summaries must be high-fidelity technical records: file paths, functions, commands, settings, decisions, errors, validation results, and user intent.
`.trim();

export const MANUAL_MODE_SYSTEM_PROMPT = `
You are operating with pi-dcp-stable in manual mode.

Do not proactively call \`compress\`. Only call it when the user explicitly requests compression or a critical context-limit reminder says continuing without compression is unsafe.
If you do compress, continue the original user-facing answer afterwards.
Never output DCP metadata tags.
`.trim();

export const COMPRESS_RANGE_DESCRIPTION = `Collapse one or more closed conversation ranges into detailed summaries.

Use this tool only for stale, completed ranges. Do not compress active work or the newest context needed to answer the user.

Each range uses visible DCP boundary IDs:
- mNNN IDs identify raw visible messages.
- bN IDs identify compressed blocks.

The summary must preserve all important technical context: user intent, files changed/read, code behavior, commands, settings, errors, validations, decisions, and follow-up requirements.

When a selected range includes a previously compressed block, include its placeholder exactly once using (bN), unless your summary explicitly restates all of its content.

After using this tool, continue the user-facing answer you were preparing. Never end the task with only a compression status.`;

export const CRITICAL_NUDGE = `<dcp-system-reminder>
CRITICAL WARNING: MAX CONTEXT LIMIT REACHED

You are at or beyond the configured max context threshold. This is an emergency context-recovery moment.

You MUST use the \`compress\` tool now. Do not continue normal exploration until compression is handled.

If you are in the middle of a critical atomic operation, finish that atomic step first, then compress immediately.

SELECTION PROCESS
Start from older, resolved history and capture as much stale context as safely possible in one pass.
Avoid the newest active working messages unless it is clearly closed.

SUMMARY REQUIREMENTS
Your summary MUST cover all essential details from the selected messages so work can continue.
If the compressed range includes user messages, preserve user intent exactly. Prefer direct quotes for short user messages to avoid semantic drift.
</dcp-system-reminder>`;

export const TURN_NUDGE = `<dcp-system-reminder>
Evaluate the conversation for compressible ranges.

If any messages are cleanly closed and unlikely to be needed again, use the compress tool on them.
If direction has shifted, compress earlier ranges that are now less relevant.

The goal is to filter noise and distill key information so context accumulation stays under control.
Keep active context uncompressed.
</dcp-system-reminder>`;

export const ITERATION_NUDGE = `<dcp-system-reminder>
You've been iterating for a while after the last user message.

If there is a closed portion that is unlikely to be referenced immediately (for example, finished research before implementation), use the compress tool on it now.
</dcp-system-reminder>`;

export const HOUSEKEEPING_NUDGE = TURN_NUDGE;

export const CONTINUE_AFTER_COMPRESS = `Compression complete. Continue the user-facing answer or task you were preparing before compression. Do not summarize the compression unless the user asked about DCP.`;
