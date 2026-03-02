export interface FixtureContextSource {
  name: string;
  type: "FILE" | "PASTE";
  content: string;
  mimeType?: string;
  enabled?: boolean;
}

export interface FixtureToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FixtureQualityRubric {
  minConfidenceScore: number;
  minToolCalls: number;
  maxToolCalls: number;
  requireWorkItemMutation: boolean;
}

export interface WriterRegressionFixture {
  id: string;
  transcript: string;
  projectContext: string;
  contextSources: FixtureContextSource[];
  expectedToolCalls: FixtureToolCall[];
  qualityRubric: FixtureQualityRubric;
}

export const WRITER_REGRESSION_FIXTURES: WriterRegressionFixture[] = [
  {
    id: "bug_report_reset_link_timeout",
    transcript:
      "Support confirms the password reset link expires in under a minute in production. " +
      "Please log a bug with repro steps and expected behavior so engineering can triage today.",
    projectContext: "ID:1 Type:EPIC Title:\"Authentication Reliability\"",
    contextSources: [
      {
        name: "incident-auth-2026-03-01.md",
        type: "FILE",
        content: "Issue appears after deploy 2026.03.01. Link token validation may use server local time.",
        mimeType: "text/markdown",
        enabled: true,
      },
    ],
    expectedToolCalls: [
      {
        name: "createWorkItem",
        args: {
          type: "BUG",
          title: "Password reset link expires too quickly",
          description: "Users cannot complete password reset before link expiry.",
          stepsToReproduce: [
            "Open reset email",
            "Click reset link after receiving the message",
            "Observe immediate expiry message",
          ],
          expectedResult: "Reset link stays valid for the configured expiration window.",
          actualResult: "Reset link is already expired on first click.",
        },
      },
    ],
    qualityRubric: {
      minConfidenceScore: 0.62,
      minToolCalls: 1,
      maxToolCalls: 2,
      requireWorkItemMutation: true,
    },
  },
  {
    id: "feature_story_breakdown_exports",
    transcript:
      "We need a finance export capability for billing operations. Create a feature for bulk export and " +
      "a child story for CSV generation with acceptance criteria for role access and successful download.",
    projectContext: "ID:5 Type:EPIC Title:\"Billing Modernization\"",
    contextSources: [
      {
        name: "billing-roadmap.txt",
        type: "PASTE",
        content: "Q2 objective includes finance self-service reporting and secure export controls.",
        mimeType: "text/plain",
        enabled: true,
      },
    ],
    expectedToolCalls: [
      {
        name: "createWorkItem",
        args: {
          type: "FEATURE",
          title: "Bulk export for billing reports",
          description: "Provide finance users with a secure bulk export workflow for billing data.",
          criteria: [
            {
              text: "Given authorized finance role, when user requests an export, then system queues a downloadable artifact.",
              met: false,
            },
          ],
          tempId: "F1",
        },
      },
      {
        name: "createWorkItem",
        args: {
          type: "STORY",
          title: "Generate CSV export package",
          description: "As a finance analyst, I want CSV export files so I can reconcile invoices externally.",
          criteria: [
            {
              text: "Given an export request, when processing completes, then user can download a CSV file containing selected rows.",
              met: false,
            },
            {
              text: "Given a non-finance user, when accessing export endpoint, then access is denied.",
              met: false,
            },
          ],
          parentTempId: "F1",
          tempId: "S1",
        },
      },
    ],
    qualityRubric: {
      minConfidenceScore: 0.7,
      minToolCalls: 2,
      maxToolCalls: 3,
      requireWorkItemMutation: true,
    },
  },
  {
    id: "mixed_chatter_with_action_items",
    transcript:
      "Before we wrap, great demo everyone and thanks for staying late. Action item: update item 2 title to " +
      "include login callback bug, and create a task to add retry logging for OAuth callback failures.",
    projectContext:
      "ID:2 Type:STORY Title:\"Stabilize login callback\" \nID:3 Type:TASK Title:\"Review auth observability\"",
    contextSources: [
      {
        name: "ops-notes.txt",
        type: "FILE",
        content: "Retry logs are missing request correlation IDs on callback failures.",
        mimeType: "text/plain",
        enabled: true,
      },
    ],
    expectedToolCalls: [
      {
        name: "updateWorkItem",
        args: {
          id: "2",
          title: "Stabilize login callback bug handling",
        },
      },
      {
        name: "createWorkItem",
        args: {
          type: "TASK",
          title: "Add retry logging for OAuth callback failures",
          description: "Capture retry attempts with correlation IDs when callback validation fails.",
        },
      },
    ],
    qualityRubric: {
      minConfidenceScore: 0.58,
      minToolCalls: 1,
      maxToolCalls: 3,
      requireWorkItemMutation: true,
    },
  },
  {
    id: "ambiguous_discussion_no_action",
    transcript:
      "Let's revisit onboarding later. No concrete action now.",
    projectContext: "ID:9 Type:EPIC Title:\"Onboarding\"",
    contextSources: [],
    expectedToolCalls: [],
    qualityRubric: {
      minConfidenceScore: 0.58,
      minToolCalls: 0,
      maxToolCalls: 0,
      requireWorkItemMutation: false,
    },
  },
];

export const buildOpenAiStreamEvents = (
  toolCalls: FixtureToolCall[],
): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    const callId = `fc_fixture_${index + 1}`;
    events.push({
      type: "response.output_item.added",
      item: {
        id: callId,
        type: "function_call",
        name: call.name,
      },
    });
    events.push({
      type: "response.function_call_arguments.delta",
      item_id: callId,
      delta: JSON.stringify(call.args),
    });
    events.push({
      type: "response.function_call_arguments.done",
      item_id: callId,
    });
  }

  events.push({
    type: "response.completed",
    response: {
      id: "resp_fixture_done",
      output: [],
    },
  });
  return events;
};

export const buildAnthropicStreamEvents = (
  toolCalls: FixtureToolCall[],
): Array<Record<string, unknown>> => {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_fixture_start",
      },
    },
  ];

  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    events.push({
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: `toolu_fixture_${index + 1}`,
        name: call.name,
      },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.args),
      },
    });
    events.push({
      type: "content_block_stop",
      index,
    });
  }

  events.push({
    type: "message_delta",
    delta: {
      stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    },
  });
  events.push({
    type: "message_stop",
  });

  return events;
};
