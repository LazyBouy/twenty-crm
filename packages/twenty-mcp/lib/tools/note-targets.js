"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noteTargetToolDefinitions = exports.buildNoteTargetHandlers = exports.buildCreateNoteTargetMutation = exports.linkNoteToRecordInputSchema = void 0;
const zod_1 = require("zod");
/**
 * Note-target linking — attach an existing Note to a CRM record (Company / Person /
 * Opportunity). Routes through Twenty's GraphQL `createOneNoteTarget` mutation
 * because the standard `execute_tool → create_note_target` path is blocked by
 * Twenty's workflow gate (CreateRecordService rejects every isSystem object
 * regardless of caller; noteTarget is isSystem). GraphQL bypasses that gate.
 *
 * See plans/note-target-linking-fix.md for the root-cause analysis.
 */
exports.linkNoteToRecordInputSchema = zod_1.z
    .object({
    noteId: zod_1.z.string().uuid().describe('The Note id to link.'),
    targetCompanyId: zod_1.z
        .string()
        .uuid()
        .optional()
        .describe('Company id to attach the note to.'),
    targetPersonId: zod_1.z.string().uuid().optional().describe('Person id to attach the note to.'),
    targetOpportunityId: zod_1.z
        .string()
        .uuid()
        .optional()
        .describe('Opportunity id to attach the note to.'),
})
    .refine((v) => [v.targetCompanyId, v.targetPersonId, v.targetOpportunityId].filter(Boolean).length === 1, {
    message: 'Exactly one of targetCompanyId / targetPersonId / targetOpportunityId is required. To link to multiple records, call this tool once per record.',
});
const buildCreateNoteTargetMutation = (args) => ({
    query: `mutation($data: NoteTargetCreateInput!) {
    createOneNoteTarget(data: $data) {
      id
      noteId
      targetCompanyId
      targetPersonId
      targetOpportunityId
    }
  }`,
    variables: {
        data: {
            noteId: args.noteId,
            targetCompanyId: args.targetCompanyId ?? null,
            targetPersonId: args.targetPersonId ?? null,
            targetOpportunityId: args.targetOpportunityId ?? null,
        },
    },
});
exports.buildCreateNoteTargetMutation = buildCreateNoteTargetMutation;
const wrapGraphqlResult = (data) => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true, result: data }) }],
    isError: false,
});
const buildNoteTargetHandlers = (client) => ({
    linkNoteToRecord: async (args) => {
        const { query, variables } = (0, exports.buildCreateNoteTargetMutation)(args);
        const data = await client.graphqlMutation(query, variables);
        return wrapGraphqlResult(data);
    },
});
exports.buildNoteTargetHandlers = buildNoteTargetHandlers;
exports.noteTargetToolDefinitions = {
    link_note_to_record: {
        title: 'Link a note to a CRM record (company / person / opportunity)',
        description: 'Attaches an existing Note to a record so it appears under the record\'s "Notes" tab. ' +
            'Routes through the GraphQL `createOneNoteTarget` mutation, NOT through `execute_tool` — ' +
            "Twenty's record-crud path blocks system-object creation with `Object cannot be created by workflow`. " +
            'Pass `noteId` plus exactly one of `targetCompanyId` / `targetPersonId` / `targetOpportunityId`. ' +
            'For multiple targets, call this tool once per target.',
        inputSchema: exports.linkNoteToRecordInputSchema.shape,
        annotations: { destructiveHint: false, idempotentHint: false },
    },
};
//# sourceMappingURL=note-targets.js.map