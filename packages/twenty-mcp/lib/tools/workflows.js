"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workflowToolDefinitions = exports.buildWorkflowHandlers = exports.workflowCreateDraftFromVersionInputSchema = exports.workflowCreateVersionEdgeInputSchema = exports.workflowUpdateVersionStepInputSchema = exports.workflowCreateVersionStepInputSchema = exports.workflowDeactivateVersionInputSchema = exports.workflowActivateVersionInputSchema = exports.workflowCreateCompleteInputSchema = void 0;
const zod_1 = require("zod");
/**
 * Workflow-management tools.
 *
 * Twenty exposes 12 specialised inner tools for workflows. We expose 7 typed
 * proxy wrappers covering the v1 surface — create + activate/deactivate +
 * incremental step/edge editing + clone-on-edit. The remaining 5 (delete
 * step/edge, update positions, get current version, update trigger) are not
 * exposed in v1; agents that need them can use Twenty's UI or wait for v2.
 *
 * IMPORTANT: workflows do NOT route through `metadata_apply_plan`. They have
 * a state machine (DRAFT → ACTIVE → DEACTIVATED) and activation is a service
 * call with validation + side-effect creation (WorkflowAutomatedTrigger
 * record). The flat-mutations dispatcher doesn't fit. The workflow agent
 * calls these typed wrappers directly.
 *
 * Activation = validation. Twenty does not validate at creation; only at
 * activation. The wrapper surfaces validation errors via the standard
 * TwentyMcpClientError path — the agent should catch and present
 * `userFriendlyMessage` if available.
 *
 * Step `valid: boolean` is set by the AGENT (not Twenty). Set true only when
 * confident all required step settings are populated. Twenty doesn't compute
 * validity at create-time.
 *
 * Refused at the agent layer (NOT here at the proxy):
 *   - WEBHOOK trigger types (exfil channel; v2 deferral)
 *   - AI_AGENT / CODE / LOGIC_FUNCTION / DELETE_RECORD step types
 *   - SEND_EMAIL / DRAFT_EMAIL / HTTP_REQUEST steps without explicit allow-tokens
 * The proxy passes through whatever the agent sends — refusal is policy at
 * the agent prompt level.
 */
// --- Input schemas -----------------------------------------------------------
//
// Workflow JSON (trigger, steps, edges) is rich enough that mirroring the full
// Zod shapes here would duplicate hundreds of lines of Twenty's internal
// schemas. We use loose schemas at the proxy boundary and let Twenty's inner
// tool validate strictly. Agents are expected to build correct JSON per the
// workflow-versioning-protocol skill.
const looseObject = zod_1.z
    .object({})
    .passthrough()
    .describe('Free-form object — full shape validated by Twenty\'s inner tool.');
exports.workflowCreateCompleteInputSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).describe('Workflow name (display).'),
    description: zod_1.z.string().optional(),
    trigger: looseObject.describe('WorkflowTrigger JSON. Shape varies by type: DATABASE_EVENT/MANUAL/CRON. WEBHOOK is allowed at the proxy but the workflow agent refuses it (v2). See workflow-versioning-protocol skill.'),
    steps: zod_1.z
        .array(looseObject)
        .min(1)
        .describe('Array of WorkflowAction objects. Each step has `id, name, type, valid, settings, nextStepIds?, position?`. See workflow-versioning-protocol skill.'),
    stepPositions: zod_1.z
        .array(zod_1.z.object({
        stepId: zod_1.z.string(),
        position: zod_1.z.object({ x: zod_1.z.number(), y: zod_1.z.number() }),
    }))
        .optional(),
    edges: zod_1.z
        .array(zod_1.z.object({
        source: zod_1.z.string().describe('Source step id (use "trigger" for the trigger step).'),
        target: zod_1.z.string().describe('Target step id.'),
        sourceConnectionOptions: looseObject.optional(),
    }))
        .optional(),
    activate: zod_1.z
        .boolean()
        .optional()
        .describe('If true, activate the version immediately after creation. The workflow agent should pass false initially, present DRAFT to user, then call workflow_activate_version on user `activate <id>` confirmation.'),
});
exports.workflowActivateVersionInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z.string().uuid(),
});
exports.workflowDeactivateVersionInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z.string().uuid(),
});
exports.workflowCreateVersionStepInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z.string().uuid(),
    parentStepId: zod_1.z
        .string()
        .optional()
        .describe('If omitted, the step is appended at the end of the workflow.'),
    step: looseObject.describe('WorkflowAction object. See workflow-versioning-protocol skill for the type-specific shape.'),
});
exports.workflowUpdateVersionStepInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z.string().uuid(),
    stepId: zod_1.z.string(),
    step: looseObject.describe('Updated WorkflowAction object — full step replaces the previous one.'),
});
exports.workflowCreateVersionEdgeInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z.string().uuid(),
    source: zod_1.z.string().describe('Source step id (use "trigger" for the trigger step).'),
    target: zod_1.z.string().describe('Target step id.'),
    sourceConnectionOptions: looseObject
        .optional()
        .describe('Optional ITERATOR loop-connection options.'),
});
exports.workflowCreateDraftFromVersionInputSchema = zod_1.z.object({
    workflowVersionId: zod_1.z
        .string()
        .uuid()
        .describe('The version to clone. Used to edit an ACTIVE workflow without breaking immutability — clone, modify the new DRAFT, activate it, the old version becomes DEACTIVATED.'),
});
// --- Handlers ----------------------------------------------------------------
const wrapInExecute = (client, innerName, args) => client.toolsCall('execute_tool', { toolName: innerName, arguments: args });
const buildWorkflowHandlers = (client) => ({
    workflowCreateComplete: (args) => wrapInExecute(client, 'create_complete_workflow', args),
    workflowActivateVersion: (args) => wrapInExecute(client, 'activate_workflow_version', args),
    workflowDeactivateVersion: (args) => wrapInExecute(client, 'deactivate_workflow_version', args),
    workflowCreateVersionStep: (args) => wrapInExecute(client, 'create_workflow_version_step', args),
    workflowUpdateVersionStep: (args) => wrapInExecute(client, 'update_workflow_version_step', args),
    workflowCreateVersionEdge: (args) => wrapInExecute(client, 'create_workflow_version_edge', args),
    workflowCreateDraftFromVersion: (args) => wrapInExecute(client, 'create_draft_from_workflow_version', args),
});
exports.buildWorkflowHandlers = buildWorkflowHandlers;
// --- Tool definitions --------------------------------------------------------
exports.workflowToolDefinitions = {
    workflow_create_complete: {
        title: 'Create a complete workflow (Workflow + DRAFT version + steps + edges)',
        description: 'One-shot create: Workflow record + WorkflowVersion DRAFT + steps + edges. Optionally activate immediately, but the workflow agent should pass `activate: false`, present the DRAFT to the user, and call workflow_activate_version separately on user `activate <id>` confirmation.',
        inputSchema: exports.workflowCreateCompleteInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    workflow_activate_version: {
        title: 'Activate a workflow version',
        description: 'Activates a DRAFT (or last-published DEACTIVATED) version. Twenty validates trigger settings, step settings, and code-step compilation; throws on invalid. Creates a WorkflowAutomatedTrigger record for DATABASE_EVENT and CRON triggers. Updates the parent Workflow\'s lastPublishedVersionId.',
        inputSchema: exports.workflowActivateVersionInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    workflow_deactivate_version: {
        title: 'Deactivate a workflow version',
        description: 'Sets the version to DEACTIVATED and updates the parent Workflow accordingly.',
        inputSchema: exports.workflowDeactivateVersionInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    workflow_create_version_step: {
        title: 'Add a step to a DRAFT workflow version',
        description: 'Append (or insert after parentStepId) a step. The agent sets `valid: true` only when confident the step\'s settings are complete — Twenty validates only at activation.',
        inputSchema: exports.workflowCreateVersionStepInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    workflow_update_version_step: {
        title: 'Update a step in a DRAFT workflow version',
        description: 'Replace a step\'s configuration. Only DRAFT versions are mutable.',
        inputSchema: exports.workflowUpdateVersionStepInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: true },
    },
    workflow_create_version_edge: {
        title: 'Connect two steps in a DRAFT workflow version',
        description: '"Edges" are not separate records — Twenty mutates `nextStepIds` on the source step. ITERATOR loops use `sourceConnectionOptions: {connectedStepType: "ITERATOR", settings: {isConnectedToLoop: true}}`.',
        inputSchema: exports.workflowCreateVersionEdgeInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
    workflow_create_draft_from_version: {
        title: 'Clone a workflow version as a new DRAFT',
        description: 'Clone-on-edit pattern: when editing an ACTIVE version, clone it into a new DRAFT, modify the DRAFT, activate the new version, the old version automatically becomes DEACTIVATED.',
        inputSchema: exports.workflowCreateDraftFromVersionInputSchema.shape,
        annotations: { destructiveHint: true, idempotentHint: false },
    },
};
//# sourceMappingURL=workflows.js.map