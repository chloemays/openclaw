import type { Command } from "commander";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";

export function registerAuthCli(program: Command) {
  const cmd = program.command("auth").description("Authenticate with a provider");

  cmd
    .command("google-antigravity")
    .alias("antigravity")
    .description("Authenticate with Google Antigravity (OAuth)")
    .option("--manual", "Force manual flow (copy-paste URL)")
    .action(async (opts) => {
      if (opts.manual) {
        process.env.OPENCLAW_FORCE_MANUAL_AUTH = "1";
      }

      const config = await loadConfig();
      const prompter = createClackPrompter();
      const runtime = defaultRuntime;

      await prompter.intro("Google Antigravity Auth");

      try {
        await applyAuthChoicePluginProvider(
          {
            authChoice: "google-antigravity",
            config,
            prompter,
            runtime,
            setDefaultModel: false,
          },
          {
            authChoice: "google-antigravity",
            pluginId: "google-antigravity-auth",
            providerId: "google-antigravity",
            methodId: "oauth",
            label: "Google Antigravity",
          },
        );

        await prompter.outro("Authentication successful!");
      } catch (err: any) {
        runtime.error(`Auth failed: ${err.message}`);
        process.exit(1);
      }
    });

  cmd
    .command("anthropic")
    .description("Authenticate with Anthropic (via claude-cli)")
    .action(async () => {
      const { applyAuthChoiceAnthropic } = await import("./auth-choice.apply.anthropic.js");
      const config = await loadConfig();
      const prompter = createClackPrompter();
      const runtime = defaultRuntime;

      await prompter.intro("Anthropic Auth");

      try {
        await applyAuthChoiceAnthropic({
          authChoice: "setup-token",
          config,
          prompter,
          runtime,
          setDefaultModel: false,
        });

        await prompter.outro("Authentication successful!");
      } catch (err: any) {
        runtime.error(`Auth failed: ${err.message}`);
        process.exit(1);
      }
    });
}
