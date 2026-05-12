import {
  buildCreateNoteTargetMutation,
  buildNoteTargetHandlers,
  linkNoteToRecordInputSchema,
} from '../tools/note-targets';
import type { TwentyMcpClient } from '../twenty-mcp-client';

// Zod 4's `.uuid()` accepts any valid v1-v8 UUID. We use synthetic v4 UUIDs
// (variant `8` in the 17th hex position satisfies Zod's variant check).
const VALID_NOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VALID_COMPANY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VALID_PERSON = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('linkNoteToRecordInputSchema', () => {
  it('accepts exactly one target id', () => {
    expect(
      linkNoteToRecordInputSchema.safeParse({
        noteId: VALID_NOTE,
        targetCompanyId: VALID_COMPANY,
      }).success,
    ).toBe(true);

    expect(
      linkNoteToRecordInputSchema.safeParse({
        noteId: VALID_NOTE,
        targetPersonId: VALID_PERSON,
      }).success,
    ).toBe(true);
  });

  it('refuses zero target ids', () => {
    const result = linkNoteToRecordInputSchema.safeParse({
      noteId: VALID_NOTE,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('Exactly one of');
  });

  it('refuses multiple target ids in a single call', () => {
    const result = linkNoteToRecordInputSchema.safeParse({
      noteId: VALID_NOTE,
      targetCompanyId: VALID_COMPANY,
      targetPersonId: VALID_PERSON,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('Exactly one of');
  });
});

describe('buildCreateNoteTargetMutation', () => {
  it('emits a createNoteTarget GraphQL mutation with the correct variables shape', () => {
    const { query, variables } = buildCreateNoteTargetMutation({
      noteId: VALID_NOTE,
      targetCompanyId: VALID_COMPANY,
    });

    expect(query).toContain('createNoteTarget(data: $data)');
    expect(query).toContain('NoteTargetCreateInput!');
    // Result projection must surface the ids the agent can use to confirm the link.
    expect(query).toContain('id');
    expect(query).toContain('noteId');
    expect(query).toContain('targetCompanyId');

    expect(variables).toEqual({
      data: {
        noteId: VALID_NOTE,
        targetCompanyId: VALID_COMPANY,
        targetPersonId: null,
        targetOpportunityId: null,
      },
    });
  });

  it('nulls out unset target ids (Twenty expects all three keys present)', () => {
    const { variables } = buildCreateNoteTargetMutation({
      noteId: VALID_NOTE,
      targetPersonId: VALID_PERSON,
    });
    const data = (variables as { data: Record<string, unknown> }).data;
    expect(data.targetPersonId).toBe(VALID_PERSON);
    expect(data.targetCompanyId).toBeNull();
    expect(data.targetOpportunityId).toBeNull();
  });
});

describe('linkNoteToRecord handler', () => {
  it('routes through graphqlMutation, NOT toolsCall — bypassing the workflow gate', async () => {
    const toolsCall = jest.fn();
    const graphqlMutation = jest.fn().mockResolvedValue({
      createNoteTarget: {
        id: 'nt-1',
        noteId: VALID_NOTE,
        targetCompanyId: VALID_COMPANY,
      },
    });
    const client = { toolsCall, graphqlMutation } as unknown as TwentyMcpClient;
    const handlers = buildNoteTargetHandlers(client);

    const result = await handlers.linkNoteToRecord({
      noteId: VALID_NOTE,
      targetCompanyId: VALID_COMPANY,
    });

    // The whole point of this tool: it must NOT use the execute_tool path
    // because Twenty's workflow gate blocks system-object creates there.
    expect(toolsCall).not.toHaveBeenCalled();
    expect(graphqlMutation).toHaveBeenCalledTimes(1);
    const [query, variables, endpoint] = graphqlMutation.mock.calls[0];
    expect(query).toContain('createNoteTarget');
    expect((variables as { data: { noteId: string } }).data.noteId).toBe(
      VALID_NOTE,
    );
    // Bug #4 regression guard: createNoteTarget lives on /graphql, not /metadata.
    // The handler must explicitly target the data endpoint.
    expect(endpoint).toBe('graphql');

    // Result envelope shape — agents parse this.
    expect(result.isError).toBe(false);
    const block = result.content[0];
    if (block.type !== 'text') throw new Error('expected text block');
    const parsed = JSON.parse(block.text);
    expect(parsed.success).toBe(true);
    expect(parsed.result.createNoteTarget.id).toBe('nt-1');
  });
});
