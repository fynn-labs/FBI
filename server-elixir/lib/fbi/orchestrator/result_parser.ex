defmodule FBI.Orchestrator.ResultParser do
  @moduledoc "Port of src/server/orchestrator/result.ts."

  @type classification ::
          %{
            kind: :completed,
            exit_code: integer(),
            push_exit: integer(),
            head_sha: String.t(),
            branch: String.t()
          }
          | %{kind: :resume_failed, error: String.t()}
          | %{kind: :unparseable, raw: String.t()}

  @type result :: %{
          exit_code: integer(),
          push_exit: integer(),
          head_sha: String.t(),
          branch: String.t() | nil,
          title: String.t() | nil
        }

  @spec classify_result_json(String.t()) :: classification()
  def classify_result_json(raw) do
    case Jason.decode(raw) do
      {:ok, %{"stage" => "restore", "error" => err}} when is_binary(err) ->
        %{kind: :resume_failed, error: err}

      {:ok, %{"exit_code" => code}} when is_integer(code) ->
        %{kind: :completed, exit_code: code, push_exit: 0, head_sha: "", branch: ""}

      _ ->
        %{kind: :unparseable, raw: raw}
    end
  end

  @spec parse_result_json(String.t()) :: {:ok, result()} | :error
  def parse_result_json(text) do
    case Jason.decode(String.trim(text)) do
      {:ok, %{"exit_code" => ec, "push_exit" => pe, "head_sha" => hs} = map}
      when is_integer(ec) and is_integer(pe) and is_binary(hs) ->
        result = %{
          exit_code: ec,
          push_exit: pe,
          head_sha: hs,
          branch: string_val(map, "branch"),
          title: trim_title(map)
        }

        {:ok, result}

      _ ->
        :error
    end
  end

  defp string_val(map, key) do
    v = map[key]
    if is_binary(v) and v != "", do: v, else: nil
  end

  defp trim_title(map) do
    case map["title"] do
      t when is_binary(t) ->
        trimmed = t |> String.trim() |> String.slice(0, 80)
        if trimmed != "", do: trimmed, else: nil

      _ ->
        nil
    end
  end
end
