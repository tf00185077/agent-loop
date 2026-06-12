import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

const models = await client.listModels();

console.log("\n可用 models：\n");
for (const m of models) {
  console.log(`  id: ${m.id}`);
  console.log(`  name: ${m.name ?? "-"}`);
  console.log(`  capabilities: ${JSON.stringify(m.capabilities ?? {})}`);
  console.log("");
}

await client.stop();
