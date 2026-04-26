defmodule FBI.Orchestrator.DevcontainerFetcher do
  @moduledoc """
  Sparse-shallow-clones a project's repo to look for a `.devcontainer/` directory.
  Returns a map of `filename => contents` (one entry per regular file in
  `.devcontainer/`), or `nil` if the repo has no `devcontainer.json`, the SSH
  agent is unavailable, or the clone fails.

  Authentication uses the host's `ssh-agent` socket forwarded via
  `SSH_AUTH_SOCK`. Without it, returns `nil` so the orchestrator falls back to
  the built-in Dockerfile template.

  Port of `fetchDevcontainerFile` in src/server/orchestrator/index.ts.
  """

  require Logger

  @type files :: %{optional(String.t()) => String.t()}

  @spec fetch(String.t() | nil, String.t() | nil, (binary() -> any())) :: files() | nil
  def fetch(nil, _ssh_auth_sock, _on_log), do: nil
  def fetch("", _ssh_auth_sock, _on_log), do: nil
  def fetch(_repo_url, nil, _on_log), do: nil
  def fetch(_repo_url, "", _on_log), do: nil

  def fetch(repo_url, ssh_auth_sock, on_log) do
    tmp_parent = Path.join(System.tmp_dir!(), "fbi-dc-#{:rand.uniform(999_999_999)}")
    tmp = Path.join(tmp_parent, "r")

    env = [
      {"SSH_AUTH_SOCK", ssh_auth_sock},
      {"GIT_TERMINAL_PROMPT", "0"}
    ]

    try do
      File.mkdir_p!(tmp_parent)

      with {:ok, _} <-
             git(
               [
                 "clone",
                 "--depth=1",
                 "--filter=blob:none",
                 "--sparse",
                 "--no-tags",
                 repo_url,
                 tmp
               ],
               env
             ),
           {:ok, _} <- git(["-C", tmp, "sparse-checkout", "set", ".devcontainer"], env),
           {:ok, _} <- git(["-C", tmp, "checkout"], env),
           dc_dir = Path.join(tmp, ".devcontainer"),
           true <- File.exists?(Path.join(dc_dir, "devcontainer.json")) do
        files = read_dc_files(dc_dir)
        on_log.("[fbi] using repo .devcontainer/devcontainer.json\n")
        files
      else
        _ -> nil
      end
    rescue
      e ->
        Logger.warning("DevcontainerFetcher: #{inspect(e)}")
        nil
    after
      File.rm_rf!(tmp_parent)
    end
  end

  defp git(args, env) do
    case System.cmd("git", args, env: env, stderr_to_stdout: true) do
      {output, 0} -> {:ok, output}
      {output, code} -> {:error, {code, output}}
    end
  end

  defp read_dc_files(dc_dir) do
    dc_dir
    |> File.ls!()
    |> Enum.filter(fn name -> File.regular?(Path.join(dc_dir, name)) end)
    |> Enum.into(%{}, fn name -> {name, File.read!(Path.join(dc_dir, name))} end)
  end
end
