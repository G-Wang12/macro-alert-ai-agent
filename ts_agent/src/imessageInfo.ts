import "dotenv/config";

import { cloud } from "spectrum-ts";

// Diagnostic: ask Photon which iMessage line/mode this project is bound to.
//
// "Spectrum started" only proves a token was issued. This goes one step further
// and prints the actual line number(s) to text (dedicated mode) or tells you to
// use the shared Photon number with a linked sender (shared mode). Use it when
// inbound texts never reach the agent.
//
//   npm run build && npm run info

async function main(): Promise<void> {
  const projectId = process.env.PROJECT_ID;
  const projectSecret = process.env.PROJECT_SECRET ?? process.env.SECRET_KEY;
  if (!projectId || !projectSecret) {
    console.error(
      "PROJECT_ID / PROJECT_SECRET not set (see .env / .env.example).",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const info = await cloud.getImessageInfo(projectId);
    console.log(`iMessage provisioning mode: ${info.type}`);
  } catch (err) {
    console.error("getImessageInfo failed:", err);
  }

  try {
    const tokens = await cloud.issueImessageTokens(projectId, projectSecret);
    console.log(`Token type: ${tokens.type}`);

    if (tokens.type === "dedicated") {
      const numbers = tokens.numbers ?? {};
      const entries = Object.entries(numbers);
      if (entries.length === 0) {
        console.log(
          "⚠️  No dedicated numbers are provisioned for this project yet — " +
            "there is no line to text. Finish line setup in the Photon dashboard.",
        );
      } else {
        console.log("Text the agent (blue-bubble iMessage) at:");
        for (const [instanceId, phone] of entries) {
          console.log(
            `  • ${phone ?? "(not provisioned yet — null)"}  [instance ${instanceId}]`,
          );
        }
        if (entries.some(([, phone]) => !phone)) {
          console.log(
            "⚠️  A line shows null — that instance has no number yet, so texts to it won't arrive.",
          );
        }
      }
    } else {
      console.log(
        "Shared mode: text the shared Photon iMessage number from your Photon dashboard.\n" +
          "IMPORTANT: in shared mode your SENDING number must be linked to THIS project " +
          "in the dashboard, otherwise Photon can't route your texts to this agent.",
      );
    }
  } catch (err) {
    console.error("issueImessageTokens failed:", err);
    console.error(
      "If this is an auth error, PROJECT_ID / PROJECT_SECRET are wrong for this project.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
