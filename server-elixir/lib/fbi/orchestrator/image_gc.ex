defmodule FBI.Orchestrator.ImageGc do
  @moduledoc "Port of src/server/orchestrator/imageGc.ts."

  @retention_days 30

  @type sweep_result :: %{
          deleted_count: integer(),
          deleted_bytes: integer(),
          errors: [%{tag: String.t(), message: String.t()}]
        }

  @spec sweep([map()], integer(), [String.t()], String.t()) :: sweep_result()
  def sweep(projects, now_ms, always_packages, postbuild) do
    reachable =
      projects
      |> Enum.flat_map(fn p ->
        hash = compute_config_hash(p, always_packages, postbuild)
        ["fbi/p#{p.id}:#{hash}", "fbi/p#{p.id}-base:#{hash}"]
      end)
      |> MapSet.new()

    cutoff_sec = div(now_ms, 1000) - @retention_days * 86_400

    with {:ok, containers} <- FBI.Docker.list_containers(all: true),
         {:ok, images} <- FBI.Docker.list_images() do
      used_image_ids = containers |> Enum.map(& &1["ImageID"]) |> MapSet.new()

      to_delete =
        Enum.flat_map(images, fn img ->
          if MapSet.member?(used_image_ids, img["Id"]) do
            []
          else
            tags = img["RepoTags"] || []
            fbi_tags = Enum.filter(tags, &String.starts_with?(&1, "fbi/"))

            cond do
              fbi_tags == [] -> []
              img["Created"] > cutoff_sec -> []
              Enum.any?(fbi_tags, &MapSet.member?(reachable, &1)) -> []
              true -> Enum.map(fbi_tags, &{&1, img["Size"] || 0})
            end
          end
        end)

      {deleted_count, deleted_bytes, errors} =
        Enum.reduce(to_delete, {0, 0, []}, fn {tag, size}, {cnt, bytes, errs} ->
          case FBI.Docker.remove_image(tag) do
            :ok -> {cnt + 1, bytes + size, errs}
            {:error, reason} -> {cnt, bytes, [%{tag: tag, message: inspect(reason)} | errs]}
          end
        end)

      %{deleted_count: deleted_count, deleted_bytes: deleted_bytes, errors: errors}
    else
      _ -> %{deleted_count: 0, deleted_bytes: 0, errors: []}
    end
  end

  defp compute_config_hash(project, always_packages, postbuild) do
    parts = [
      Jason.encode!(project[:devcontainer_files] || %{}),
      project[:devcontainer_override_json] || "",
      Enum.join(always_packages, ","),
      postbuild
    ]

    :crypto.hash(:sha256, Enum.join(parts, "\n"))
    |> Base.encode16(case: :lower)
    |> String.slice(0, 16)
  end
end
