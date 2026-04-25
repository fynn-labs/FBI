defmodule FBI.Orchestrator.ClaudeJson do
  @moduledoc "Port of src/server/orchestrator/claudeJson.ts."

  @doc """
  Build the .claude.json content to inject into the container.
  Reads the host's ~/.claude.json, strips install fields, seeds /workspace trust,
  and injects MCP server config.
  """
  @spec build(Path.t(), list(), map()) :: String.t()
  def build(host_claude_dir, mcps, secrets) do
    host_json_path = Path.join(Path.dirname(host_claude_dir), ".claude.json")

    obj =
      case File.read(host_json_path) do
        {:ok, raw} ->
          case Jason.decode(raw) do
            {:ok, map} when is_map(map) -> map
            _ -> %{}
          end

        _ ->
          %{}
      end

    obj = Map.drop(obj, ["installMethod", "autoUpdates"])

    projects = Map.get(obj, "projects", %{})

    workspace_entry =
      Map.merge(projects["/workspace"] || %{}, %{
        "hasTrustDialogAccepted" => true,
        "hasCompletedProjectOnboarding" => true,
        "projectOnboardingSeenCount" => 1,
        "hasClaudeMdExternalIncludesApproved" => true,
        "hasClaudeMdExternalIncludesWarningShown" => true
      })

    obj = Map.put(obj, "projects", Map.put(projects, "/workspace", workspace_entry))

    mcp_config = build_mcp_config(mcps, secrets)
    obj = if map_size(mcp_config) > 0, do: Map.put(obj, "mcpServers", mcp_config), else: obj

    Jason.encode!(obj)
  end

  @doc """
  Build the claude settings JSON to inject at /home/agent/.claude/settings.json.

  Mirrors `buildClaudeSettingsJson` in src/server/orchestrator/index.ts.

  - `skipDangerousModePermissionPrompt` suppresses Claude Code's bypass-
    permissions confirmation dialog at session start.
  - `hooks.Stop` writes /fbi-state/waiting when Claude finishes a turn.
  - `hooks.UserPromptSubmit` clears /fbi-state/waiting and writes
    /fbi-state/prompted when the user submits a prompt.

  RuntimeStateWatcher polls those sentinels to derive run state
  (starting / running / waiting). If this JSON is wrong, the run never
  leaves "starting" and the bypass dialog blocks the agent before it
  even reads its prompt.
  """
  @spec build_claude_settings_json() :: String.t()
  def build_claude_settings_json do
    Jason.encode!(%{
      "skipDangerousModePermissionPrompt" => true,
      "hooks" => %{
        "Stop" => [
          %{
            "hooks" => [
              %{
                "type" => "command",
                "command" => "touch /fbi-state/waiting",
                "timeout" => 5
              }
            ]
          }
        ],
        "UserPromptSubmit" => [
          %{
            "hooks" => [
              %{
                "type" => "command",
                "command" => "rm -f /fbi-state/waiting && touch /fbi-state/prompted",
                "timeout" => 5
              }
            ]
          }
        ]
      }
    })
  end

  defp build_mcp_config(mcps, secrets) do
    Enum.reduce(mcps, %{}, fn mcp, acc ->
      resolved_env =
        Enum.reduce(mcp.env || %{}, %{}, fn {k, v}, env_acc ->
          value =
            if String.starts_with?(v, "$") do
              secrets[String.slice(v, 1..-1//1)] || ""
            else
              v
            end

          Map.put(env_acc, k, value)
        end)

      entry =
        case mcp.type do
          "stdio" ->
            base = %{
              "type" => "stdio",
              "command" => mcp.command || "npx",
              "args" => mcp.args || []
            }

            if map_size(resolved_env) > 0, do: Map.put(base, "env", resolved_env), else: base

          "sse" ->
            if is_nil(mcp.url) do
              nil
            else
              base = %{"type" => "sse", "url" => mcp.url}
              if map_size(resolved_env) > 0, do: Map.put(base, "env", resolved_env), else: base
            end

          _ ->
            nil
        end

      if entry, do: Map.put(acc, mcp.name, entry), else: acc
    end)
  end
end
