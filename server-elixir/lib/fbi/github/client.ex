defmodule FBI.Github.Client do
  @moduledoc """
  Thin wrapper around the `gh` CLI. Used to fetch PR / checks / compare / commits
  for a given repo + branch. The client shells out via `System.cmd/3`; tests
  stub the `cmd` function through a config-overridable adapter.
  """

  @type repo :: String.t()
  @type branch :: String.t()
  @type pr :: %{number: integer(), url: String.t(), state: String.t(), title: String.t()}

  @spec pr_for_branch(repo(), branch()) :: {:ok, pr() | nil} | {:error, term()}
  def pr_for_branch(repo, branch) do
    case run([
           "pr",
           "list",
           "--repo",
           repo,
           "--head",
           branch,
           "--state",
           "all",
           "--json",
           "number,url,state,title",
           "--limit",
           "1"
         ]) do
      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, [pr | _]} -> {:ok, atomize_pr(pr)}
          {:ok, _} -> {:ok, nil}
          err -> err
        end

      err ->
        err
    end
  end

  @spec pr_checks(repo(), branch()) :: {:ok, [map()]} | {:error, term()}
  def pr_checks(repo, branch) do
    case run(["pr", "checks", branch, "--repo", repo, "--json", "name,status,conclusion"]) do
      {:ok, stdout} -> Jason.decode(stdout)
      err -> err
    end
  end

  @spec commits_on_branch(repo(), branch()) :: {:ok, [map()]} | {:error, term()}
  def commits_on_branch(repo, branch) do
    case run(["api", "/repos/#{repo}/commits?sha=#{branch}&per_page=20"]) do
      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, items} when is_list(items) ->
            {:ok,
             Enum.map(items, fn i ->
               %{
                 sha: i["sha"],
                 subject: i |> get_in(["commit", "message"]) |> first_line(),
                 committed_at: i |> get_in(["commit", "committer", "date"]) |> iso8601_to_unix(),
                 pushed: true
               }
             end)}

          _ ->
            {:ok, []}
        end

      err ->
        err
    end
  end

  @spec compare_branch(repo(), String.t(), String.t()) ::
          {:ok,
           %{
             ahead_by: integer(),
             behind_by: integer(),
             merge_base_sha: String.t(),
             commits: [map()]
           }}
          | {:error, term()}
  def compare_branch(repo, base_branch, branch) do
    url = "repos/#{repo}/compare/#{URI.encode(base_branch)}...#{URI.encode(branch)}"

    case run(["api", url]) do
      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, data} ->
            commits =
              Enum.map(data["commits"] || [], fn c ->
                %{
                  sha: c["sha"],
                  subject: c |> get_in(["commit", "message"]) |> first_line(),
                  committed_at:
                    c |> get_in(["commit", "committer", "date"]) |> iso8601_to_unix(),
                  pushed: true
                }
              end)

            {:ok,
             %{
               ahead_by: data["ahead_by"] || 0,
               behind_by: data["behind_by"] || 0,
               merge_base_sha: get_in(data, ["merge_base_commit", "sha"]) || "",
               commits: commits
             }}

          err ->
            err
        end

      err ->
        err
    end
  end

  @spec compare_files(repo(), String.t(), String.t()) :: {:ok, [map()]} | {:error, term()}
  def compare_files(repo, base, head) do
    case run([
           "api",
           "repos/#{repo}/compare/#{base}...#{head}",
           "--jq",
           ".files | map({filename, additions, deletions, status})"
         ]) do
      {:ok, stdout} -> Jason.decode(stdout)
      err -> err
    end
  end

  @spec create_pr(repo(), %{
          head: String.t(),
          base: String.t(),
          title: String.t(),
          body: String.t()
        }) ::
          {:ok, pr()} | {:error, term()}
  def create_pr(repo, %{head: head, base: base, title: title, body: body}) do
    case run([
           "pr",
           "create",
           "--repo",
           repo,
           "--head",
           head,
           "--base",
           base,
           "--title",
           title,
           "--body",
           body
         ]) do
      {:ok, _} -> pr_for_branch(repo, head) |> then(fn {:ok, v} -> {:ok, v} end)
      err -> err
    end
  end

  @spec merge_branch(repo(), String.t(), String.t(), String.t()) ::
          {:ok, %{merged: true, sha: String.t()}}
          | {:ok, %{merged: false, reason: :already_merged | :conflict}}
          | {:error, :gh_error}
  def merge_branch(repo, head, base, commit_msg) do
    case run([
           "api",
           "-X",
           "POST",
           "/repos/#{repo}/merges",
           "-f",
           "base=#{base}",
           "-f",
           "head=#{head}",
           "-f",
           "commit_message=#{commit_msg}"
         ]) do
      {:ok, ""} ->
        {:ok, %{merged: false, reason: :already_merged}}

      {:ok, stdout} ->
        case Jason.decode(stdout) do
          {:ok, %{"sha" => sha}} -> {:ok, %{merged: true, sha: sha}}
          _ -> {:error, :gh_error}
        end

      {:error, {_code, stderr}} ->
        if stderr =~ "conflict" or stderr =~ "409" do
          {:ok, %{merged: false, reason: :conflict}}
        else
          {:error, :gh_error}
        end
    end
  end

  @spec available?() :: boolean()
  def available? do
    case Application.get_env(:fbi, :gh_cmd_adapter) do
      nil ->
        case System.find_executable("gh") do
          nil -> false
          _ -> true
        end

      _ ->
        true
    end
  end

  defp run(args) do
    adapter = Application.get_env(:fbi, :gh_cmd_adapter, &default_cmd/1)
    adapter.(args)
  end

  defp default_cmd(args) do
    case System.cmd("gh", args, stderr_to_stdout: false) do
      {stdout, 0} -> {:ok, String.trim_trailing(stdout)}
      {stderr, code} -> {:error, {code, stderr}}
    end
  end

  defp atomize_pr(%{"number" => n, "url" => u, "state" => s, "title" => t}),
    do: %{number: n, url: u, state: s, title: t}

  defp first_line(nil), do: ""
  defp first_line(s), do: s |> String.split("\n", parts: 2) |> List.first()

  defp iso8601_to_unix(nil), do: 0

  defp iso8601_to_unix(s) when is_binary(s) do
    case DateTime.from_iso8601(s) do
      {:ok, dt, _} -> DateTime.to_unix(dt)
      _ -> 0
    end
  end
end
