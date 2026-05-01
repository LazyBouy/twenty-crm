/**
 * Contract test — for every wrapper handler, drive it with a representative
 * input through a mock client that captures the forwarded JSON-RPC payload,
 * then validate the captured `arguments` against the inner-tool schema fixture.
 *
 * This is the test layer that would have caught the data-wrapper bug. It
 * pairs structural invariants (`forbiddenTopLevel` keys must not appear) with
 * optional ajv schema validation for tools where we have a concrete schema.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv';

import { buildAccessHandlers } from '../tools/access';
import { buildCrmHandlers } from '../tools/crm';
import { buildMetadataHandlers } from '../tools/metadata';
import { buildViewHandlers } from '../tools/views';
import { buildWorkflowHandlers } from '../tools/workflows';
import type { TwentyMcpClient } from '../twenty-mcp-client';

type FixtureEntry = {
  schema: unknown | null;
  forbiddenTopLevel: string[];
};

type Fixture = {
  tools: Record<string, FixtureEntry>;
};

const fixture: Fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'inner-tool-schemas.json'), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });

const fixtureKey = (innerName: string): string => {
  if (innerName.startsWith('find_one_')) return 'find_one_<singular>';
  if (innerName.startsWith('find_')) return 'find_<plural>';
  if (
    [
      'create_object_metadata',
      'create_field_metadata',
      'create_many_field_metadata',
      'create_many_relation_fields',
      'create_view',
      'create_view_field',
      'create_many_view_fields',
      'create_view_filter',
      'create_view_sort',
      'create_complete_workflow',
      'create_workflow_version_step',
      'create_workflow_version_edge',
      'create_draft_from_workflow_version',
    ].includes(innerName)
  ) {
    return innerName;
  }
  if (innerName.startsWith('create_')) return 'create_<singular>';
  if (
    [
      'update_object_metadata',
      'update_field_metadata',
      'update_view',
      'update_view_field',
      'update_view_filter',
      'update_workflow_version_step',
    ].includes(innerName)
  ) {
    return innerName;
  }
  if (innerName.startsWith('update_')) return 'update_<singular>';
  if (innerName.startsWith('delete_')) return 'delete_<singular>';

  return innerName;
};

/**
 * Build a TwentyMcpClient stub that captures the most-recent execute_tool /
 * graphqlMutation invocation. Returns the stub plus a `lastCall` accessor.
 */
const makeCapturingClient = (): {
  client: TwentyMcpClient;
  lastInner(): { toolName: string; args: Record<string, unknown> };
  lastGraphql(): { query: string; variables: Record<string, unknown> };
} => {
  let inner: { toolName: string; args: Record<string, unknown> } | undefined;
  let gql: { query: string; variables: Record<string, unknown> } | undefined;
  const client = {
    toolsCall: jest
      .fn()
      .mockImplementation((name: string, args: Record<string, unknown>) => {
        if (name === 'execute_tool') {
          inner = {
            toolName: args.toolName as string,
            args: (args.arguments ?? {}) as Record<string, unknown>,
          };
        }

        return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
      }),
    graphqlMutation: jest
      .fn()
      .mockImplementation((query: string, variables: Record<string, unknown>) => {
        gql = { query, variables };

        return Promise.resolve({});
      }),
  } as unknown as TwentyMcpClient;

  return {
    client,
    lastInner: () => {
      if (!inner) throw new Error('No execute_tool call captured');

      return inner;
    },
    lastGraphql: () => {
      if (!gql) throw new Error('No graphqlMutation call captured');

      return gql;
    },
  };
};

const assertContract = (innerToolName: string, args: Record<string, unknown>): void => {
  const key = fixtureKey(innerToolName);
  const entry = fixture.tools[key];
  if (!entry) {
    throw new Error(
      `No fixture entry for inner tool "${innerToolName}" (resolved key: "${key}"). Add one to inner-tool-schemas.json.`,
    );
  }
  for (const forbidden of entry.forbiddenTopLevel) {
    if (Object.prototype.hasOwnProperty.call(args, forbidden)) {
      throw new Error(
        `Wrapper for ${innerToolName} forwarded forbidden top-level key "${forbidden}". This is the wrapper-bug class — wrapper-only keys (object/data/filter/etc.) must be unwrapped before forwarding.`,
      );
    }
  }
  if (entry.schema) {
    const validate = ajv.compile(entry.schema as object);
    if (!validate(args)) {
      throw new Error(
        `Wrapper for ${innerToolName} forwarded args that fail the inner schema: ${ajv.errorsText(validate.errors)}`,
      );
    }
  }
};

describe('contract: wrapper output shape vs Twenty inner-tool schemas', () => {
  describe('crm.ts', () => {
    it('searchRecords spreads filter + omits wrapper-only keys', async () => {
      const cap = makeCapturingClient();
      const crm = buildCrmHandlers(cap.client);
      await crm.searchRecords({
        object: 'people',
        filter: { city: { eq: 'Berlin' } },
        limit: 5,
        orderBy: [{ name: 'AscNullsFirst' }],
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('find_people');
      assertContract(captured.toolName, captured.args);
    });

    it('getRecord forwards only {id}', async () => {
      const cap = makeCapturingClient();
      const crm = buildCrmHandlers(cap.client);
      await crm.getRecord({ object: 'people', id: 'abc' });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('find_one_person');
      assertContract(captured.toolName, captured.args);
    });

    it('createRecord flattens data', async () => {
      const cap = makeCapturingClient();
      const crm = buildCrmHandlers(cap.client);
      await crm.createRecord({
        object: 'companies',
        data: { name: 'Acme', employees: 42 },
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_company');
      assertContract(captured.toolName, captured.args);
    });

    it('updateRecord sends {id, ...data}', async () => {
      const cap = makeCapturingClient();
      const crm = buildCrmHandlers(cap.client);
      await crm.updateRecord({
        object: 'companies',
        id: 'c1',
        data: { name: 'Acme2' },
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('update_company');
      assertContract(captured.toolName, captured.args);
    });

    it('deleteRecord forwards only {id}', async () => {
      const cap = makeCapturingClient();
      const crm = buildCrmHandlers(cap.client);
      await crm.deleteRecord({ object: 'people', id: 'p1' });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('delete_person');
      assertContract(captured.toolName, captured.args);
    });
  });

  describe('metadata.ts', () => {
    it('metadataCreateObject forwards flat fields', async () => {
      const cap = makeCapturingClient();
      const md = buildMetadataHandlers(cap.client, 'fake.jwt.token');
      await md.metadataCreateObject({
        nameSingular: 'foo',
        namePlural: 'foos',
        labelSingular: 'Foo',
        labelPlural: 'Foos',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_object_metadata');
      assertContract(captured.toolName, captured.args);
    });

    it('metadataUpdateObject forwards flat {id, ...fields}', async () => {
      const cap = makeCapturingClient();
      const md = buildMetadataHandlers(cap.client, 'fake.jwt.token');
      await md.metadataUpdateObject({
        id: '00000000-0000-0000-0000-000000000000',
        labelSingular: 'X',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('update_object_metadata');
      assertContract(captured.toolName, captured.args);
    });

    it('metadataCreateField forwards flat fields', async () => {
      const cap = makeCapturingClient();
      const md = buildMetadataHandlers(cap.client, 'fake.jwt.token');
      await md.metadataCreateField({
        objectMetadataId: '00000000-0000-0000-0000-000000000000',
        type: 'TEXT',
        name: 'foo',
        label: 'Foo',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_field_metadata');
      assertContract(captured.toolName, captured.args);
    });

    it('metadataCreateManyFields forwards {fields: [...]}', async () => {
      const cap = makeCapturingClient();
      const md = buildMetadataHandlers(cap.client, 'fake.jwt.token');
      await md.metadataCreateManyFields({
        fields: [
          {
            objectMetadataId: '00000000-0000-0000-0000-000000000000',
            type: 'TEXT',
            name: 'foo',
            label: 'Foo',
          },
        ],
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_many_field_metadata');
      assertContract(captured.toolName, captured.args);
    });

    it('metadataCreateRelation transforms to {relations: [args]}', async () => {
      const cap = makeCapturingClient();
      const md = buildMetadataHandlers(cap.client, 'fake.jwt.token');
      await md.metadataCreateRelation({
        objectMetadataId: '00000000-0000-0000-0000-000000000000',
        name: 'rel',
        label: 'Rel',
        type: 'MANY_TO_ONE',
        targetObjectMetadataId: '11111111-1111-1111-1111-111111111111',
        targetFieldLabel: 'Inverse',
        targetFieldIcon: 'IconLink',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_many_relation_fields');
      assertContract(captured.toolName, captured.args);
      expect(captured.args).toHaveProperty('relations');
      expect(Array.isArray(captured.args.relations)).toBe(true);
    });
  });

  describe('views.ts', () => {
    it('metadataCreateView forwards flat fields', async () => {
      const cap = makeCapturingClient();
      const v = buildViewHandlers(cap.client);
      await v.metadataCreateView({
        name: 'My View',
        objectNameSingular: 'company',
        visibility: 'WORKSPACE',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_view');
      assertContract(captured.toolName, captured.args);
    });

    it('metadataCreateViewField forwards flat fields', async () => {
      const cap = makeCapturingClient();
      const v = buildViewHandlers(cap.client);
      await v.metadataCreateViewField({
        viewId: '00000000-0000-0000-0000-000000000000',
        fieldMetadataId: '11111111-1111-1111-1111-111111111111',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_view_field');
      assertContract(captured.toolName, captured.args);
    });
  });

  describe('workflows.ts', () => {
    it('workflowActivateVersion forwards {workflowVersionId}', async () => {
      const cap = makeCapturingClient();
      const wf = buildWorkflowHandlers(cap.client);
      await wf.workflowActivateVersion({
        workflowVersionId: '00000000-0000-0000-0000-000000000000',
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('activate_workflow_version');
      assertContract(captured.toolName, captured.args);
    });

    it('workflowCreateComplete forwards flat fields', async () => {
      const cap = makeCapturingClient();
      const wf = buildWorkflowHandlers(cap.client);
      await wf.workflowCreateComplete({
        name: 'Demo',
        trigger: { type: 'MANUAL' },
        steps: [{ id: 's1', name: 'Step 1', type: 'CODE', valid: false, settings: {} }],
      });
      const captured = cap.lastInner();
      expect(captured.toolName).toBe('create_complete_workflow');
      assertContract(captured.toolName, captured.args);
    });
  });

  describe('access.ts (GraphQL transport)', () => {
    it('accessUpdateRole reshapes flat input into {id, update: {...}}', async () => {
      const cap = makeCapturingClient();
      const ax = buildAccessHandlers(cap.client);
      await ax.accessUpdateRole({ id: '00000000-0000-0000-0000-000000000000', label: 'X' });
      const { variables } = cap.lastGraphql();
      expect(variables).toMatchObject({
        input: { id: '00000000-0000-0000-0000-000000000000', update: { label: 'X' } },
      });
    });

    it('accessSendInvitations spreads emails/roleId at the top of variables', async () => {
      const cap = makeCapturingClient();
      const ax = buildAccessHandlers(cap.client);
      await ax.accessSendInvitations({
        emails: ['a@b.com'],
        roleId: '00000000-0000-0000-0000-000000000000',
      });
      const { variables } = cap.lastGraphql();
      expect(variables).toEqual({
        emails: ['a@b.com'],
        roleId: '00000000-0000-0000-0000-000000000000',
      });
      expect(variables).not.toHaveProperty('input');
    });
  });
});
