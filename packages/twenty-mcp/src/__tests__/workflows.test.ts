import { buildWorkflowHandlers } from '../tools/workflows';
import { TwentyMcpClient } from '../twenty-mcp-client';

const makeClient = () => {
  const toolsCall = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

  return { toolsCall, client: { toolsCall } as unknown as TwentyMcpClient };
};

describe('workflows — wire-level routing', () => {
  it.each([
    [
      'workflowCreateComplete',
      'create_complete_workflow',
      { name: 'w', trigger: { type: 'MANUAL' }, steps: [{ type: 'EMPTY' }] },
    ],
    [
      'workflowActivateVersion',
      'activate_workflow_version',
      { workflowVersionId: '00000000-0000-0000-0000-000000000001' },
    ],
    [
      'workflowDeactivateVersion',
      'deactivate_workflow_version',
      { workflowVersionId: '00000000-0000-0000-0000-000000000001' },
    ],
    [
      'workflowCreateVersionStep',
      'create_workflow_version_step',
      {
        workflowVersionId: '00000000-0000-0000-0000-000000000001',
        step: { type: 'CREATE_RECORD' },
      },
    ],
    [
      'workflowUpdateVersionStep',
      'update_workflow_version_step',
      {
        workflowVersionId: '00000000-0000-0000-0000-000000000001',
        stepId: 'step-1',
        step: { type: 'CREATE_RECORD' },
      },
    ],
    [
      'workflowCreateVersionEdge',
      'create_workflow_version_edge',
      {
        workflowVersionId: '00000000-0000-0000-0000-000000000001',
        source: 'trigger',
        target: 'step-1',
      },
    ],
    [
      'workflowCreateDraftFromVersion',
      'create_draft_from_workflow_version',
      { workflowVersionId: '00000000-0000-0000-0000-000000000001' },
    ],
  ] as const)('%s routes to %s', async (handlerName, innerTool, args) => {
    const { toolsCall, client } = makeClient();
    const handlers = buildWorkflowHandlers(client);

    await (handlers[handlerName] as (a: unknown) => Promise<unknown>)(args);

    expect(toolsCall).toHaveBeenCalledWith(
      'execute_tool',
      expect.objectContaining({ toolName: innerTool, arguments: args }),
    );
  });
});
