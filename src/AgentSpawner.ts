import { CopilotClient, approveAll, type CopilotSession } from "@github/copilot-sdk";

/**
 * AgentDefinition — defines one custom sub-agent
 */
export interface AgentDefinition {
  name: string;
  displayName?: string;
  description: string;
  tools?: string[];
  prompt: string;
  infer?: boolean;
  skills?: string[];
}

/**
 * SpawnOptions — options for spawning a session with custom agents
 */
export interface SpawnOptions {
  /** Which model to use, e.g. "gpt-4.1", "claude-sonnet-4.5" */
  model?: string;
  /** Pre-select one agent by name at session creation */
  defaultAgent?: string;
  /** User prompt to send after session is ready */
  prompt: string;
  /** Directories to search for skill files */
  skillDirectories?: string[];
}

/**
 * SpawnResult — what comes back after a spawn run
 */
export interface SpawnResult {
  sessionId: string;
  response: string;
  events: string[];
}

/**
 * AgentSpawner — creates a CopilotClient, registers custom agents,
 * sends a prompt, and streams the result back.
 */
export class AgentSpawner {
  private agents: AgentDefinition[];

  constructor(agents: AgentDefinition[]) {
    this.agents = agents;
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const client = new CopilotClient();
    await client.start();

    try {
      const session: CopilotSession = await client.createSession({
        model: options.model ?? "claude-sonnet-4.6",
        // Map our AgentDefinition to the SDK's customAgents shape
        customAgents: this.agents.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          description: a.description,
          tools: a.tools,
          prompt: a.prompt,
          infer: a.infer,
          skills: a.skills,
        })),
        ...(options.defaultAgent ? { agent: options.defaultAgent } : {}),
        ...(options.skillDirectories
          ? { skillDirectories: options.skillDirectories }
          : {}),
        onPermissionRequest: approveAll,
      });

      const events: string[] = [];
      let finalResponse = "";

      // Collect sub-agent lifecycle events
      session.on("subagent.selected", (e: any) => {
        const label = `[subagent.selected] ${e.data?.agentName ?? "unknown"}`;
        events.push(label);
        console.log(label);
      });

      session.on("subagent.started", (e: any) => {
        const label = `[subagent.started] ${e.data?.agentName ?? "unknown"}`;
        events.push(label);
        console.log(label);
      });

      session.on("subagent.completed", (e: any) => {
        const label = `[subagent.completed] ${e.data?.agentName ?? "unknown"}`;
        events.push(label);
        console.log(label);
      });

      session.on("subagent.failed", (e: any) => {
        const label = `[subagent.failed] ${e.data?.agentName ?? "unknown"}: ${e.data?.errorMessage ?? ""}`;
        events.push(label);
        console.error(label);
      });

      session.on("assistant.message_delta", (e: any) => {
        process.stdout.write(e.data?.deltaContent ?? "");
      });

      const idle = new Promise<void>((resolve) => {
        session.on("session.idle", () => resolve());
      });

      await session.send({ prompt: options.prompt });
      await idle;

      // Pull the final assistant message
      const allEvents = await session.getEvents();
      const lastMsg = [...allEvents]
        .reverse()
        .find((e: any) => e.type === "assistant.message");
      if (lastMsg) {
        finalResponse = (lastMsg as any).data?.content ?? "";
      }

      const result: SpawnResult = {
        sessionId: session.sessionId,
        response: finalResponse,
        events,
      };

      await session.disconnect();
      return result;
    } finally {
      await client.stop();
    }
  }
}
