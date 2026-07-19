import log from "./logger.js";

const PLUGIN_NAME = "[04-simple-plugin]";

const server = async (input, options) => {
  const { client, project, directory, worktree, $ } = input;

  return {
    dispose: async () => {
      log(PLUGIN_NAME, "dispose");
    },

    event: async (input) => {
      log(PLUGIN_NAME, "event", input.event.type);
    },

    config: async (input) => {
      log(PLUGIN_NAME, "config");
    },

    "chat.message": async (input, output) => {
      const { sessionID, agent, model, messageID, variant } = input;
      const { message, parts } = output;
      const textContent = parts?.map(p => p.text).filter(Boolean).join("\n");
      log(PLUGIN_NAME, "chat.message", {
        sessionID,
        agent,
        model,
        messageID,
        variant,
        role: message?.role,
        partsCount: parts?.length,
        text: textContent,
      });
    },

    "chat.params": async (input, output) => {
      const { sessionID, agent, model, provider, message } = input;
      const { temperature, topP, topK, maxOutputTokens } = output;
      log(PLUGIN_NAME, "chat.params", {
        sessionID,
        agent,
        model: model?.id,
        provider: provider?.source,
        temperature,
        topP,
        topK,
        maxOutputTokens,
      });
    },

    "chat.headers": async (input, output) => {
      const { sessionID, agent, model, provider, message } = input;
      const { headers } = output;
      log(PLUGIN_NAME, "chat.headers", {
        sessionID,
        agent,
        model: model?.id,
        provider: provider?.source,
        headerKeys: Object.keys(headers),
      });
    },

    "permission.ask": async (input, output) => {
      const { permission, command, tool, sessionID } = input;
      log(PLUGIN_NAME, "permission.ask", {
        permission,
        command,
        tool,
        sessionID,
      });
    },

    "command.execute.before": async (input, output) => {
      const { command, sessionID, arguments: args } = input;
      log(PLUGIN_NAME, "command.execute.before", {
        command,
        sessionID,
        args,
      });
    },

    "tool.execute.before": async (input, output) => {
      const { tool, sessionID, callID } = input;
      const { args } = output;
      log(PLUGIN_NAME, "tool.execute.before", {
        tool,
        sessionID,
        callID,
      });
    },

    "shell.env": async (input, output) => {
      const { cwd, sessionID, callID } = input;
      const { env } = output;
      log(PLUGIN_NAME, "shell.env", {
        cwd,
        sessionID,
        callID,
        envKeys: Object.keys(env),
      });
    },

    "tool.execute.after": async (input, output) => {
      const { tool, sessionID, callID, args } = input;
      const { title, output: toolOutput } = output;
      log(PLUGIN_NAME, "tool.execute.after", {
        tool,
        sessionID,
        callID,
        title,
        outputLength: toolOutput?.length,
      });
    },

    "experimental.chat.messages.transform": async (input, output) => {
      const { messages } = output;
      const summary = messages?.map(m => ({
        role: m.role,
        content: m.parts?.map(p => p.text).filter(Boolean).join("\n"),
      }));
      log(PLUGIN_NAME, "experimental.chat.messages.transform", {
        messageCount: messages?.length,
        messages: summary,
      });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const { sessionID, model } = input;
      const { system } = output;
      log(PLUGIN_NAME, "experimental.chat.system.transform", {
        sessionID,
        model: model?.id,
        systemCount: system?.length,
      });
    },

    "experimental.provider.small_model": async (input, output) => {
      const { provider } = input;
      const { model } = output;
      log(PLUGIN_NAME, "experimental.provider.small_model", {
        provider: provider?.id,
        model: model?.id,
      });
    },

    "experimental.session.compacting": async (input, output) => {
      const { sessionID } = input;
      const { context, prompt } = output;
      log(PLUGIN_NAME, "experimental.session.compacting", {
        sessionID,
        contextCount: context?.length,
        hasCustomPrompt: !!prompt,
      });
    },

    "experimental.compaction.autocontinue": async (input, output) => {
      const { sessionID, agent, model, message, overflow } = input;
      const { enabled } = output;
      log(PLUGIN_NAME, "experimental.compaction.autocontinue", {
        sessionID,
        agent,
        model: model?.id,
        overflow,
        enabled,
      });
    },

    "experimental.text.complete": async (input, output) => {
      const { sessionID, messageID, partID } = input;
      const { text } = output;
      log(PLUGIN_NAME, "experimental.text.complete", {
        sessionID,
        messageID,
        partID,
        textLength: text?.length,
        text,
      });
    },

    "tool.definition": async (input, output) => {
      const { toolID } = input;
      const { description, parameters } = output;
      log(PLUGIN_NAME, "tool.definition", {
        toolID,
        description,
        hasParameters: !!parameters,
      });
    },
  };
};

export default {
  id: "04-simple-plugin",
  server,
};
