defmodule FBI.Orchestrator.ImageBuilder do
  @moduledoc "Port of src/server/orchestrator/image.ts."

  require Logger

  @always_packages ~w(git openssh-client gh ca-certificates claude-cli)

  @dockerfile_tmpl """
  FROM __BASE_IMAGE__
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends __APT_PACKAGES__ && rm -rf /var/lib/apt/lists/*
  __ENV_EXPORTS__
  """

  def always_packages, do: @always_packages

  @doc "Build or retrieve the final tagged image. Calls `on_log.(chunk)` with build output."
  def resolve(opts) do
    project_id = opts.project_id
    devcontainer_files = opts.devcontainer_files
    override_json = opts.override_json
    on_log = opts.on_log

    postbuild = read_postbuild()
    hash = compute_config_hash(devcontainer_files, override_json, postbuild)
    final_tag = "fbi/p#{project_id}:#{hash}"

    if image_exists?(final_tag) do
      {:ok, final_tag}
    else
      base_tag = "fbi/p#{project_id}-base:#{hash}"

      unless image_exists?(base_tag) do
        if devcontainer_files do
          build_devcontainer(devcontainer_files, base_tag, on_log)
        else
          build_fallback(override_json, base_tag, on_log)
        end
      end

      build_post_layer(base_tag, final_tag, postbuild, on_log)
      {:ok, final_tag}
    end
  end

  defp read_postbuild do
    path =
      Application.get_env(
        :fbi,
        :postbuild_sh_path,
        Path.join(:code.priv_dir(:fbi), "static/postbuild.sh")
      )

    case File.read(path) do
      {:ok, content} -> content
      _ -> ""
    end
  end

  defp compute_config_hash(devcontainer_files, override_json, postbuild) do
    parts = [
      Jason.encode!(devcontainer_files || %{}),
      override_json || "",
      Enum.join(@always_packages, ","),
      postbuild
    ]

    :crypto.hash(:sha256, Enum.join(parts, "\n"))
    |> Base.encode16(case: :lower)
    |> String.slice(0, 16)
  end

  defp image_exists?(tag) do
    case FBI.Docker.list_images() do
      {:ok, images} ->
        Enum.any?(images, fn img ->
          tags = img["RepoTags"] || []
          tag in tags
        end)

      _ ->
        false
    end
  end

  defp build_devcontainer(files, tag, on_log) do
    tmp = System.tmp_dir!()
    work_dir = Path.join(tmp, "fbi-dc-#{:rand.uniform(999_999)}")
    dc_dir = Path.join(work_dir, ".devcontainer")
    File.mkdir_p!(dc_dir)

    Enum.each(files, fn {name, content} ->
      File.write!(Path.join(dc_dir, name), content)
    end)

    try do
      on_log.("[fbi] building devcontainer image #{tag}\n")

      {output, exit_code} =
        System.cmd(
          "npx",
          [
            "-y",
            "@devcontainers/cli@0.67.0",
            "build",
            "--workspace-folder",
            work_dir,
            "--image-name",
            tag
          ],
          stderr_to_stdout: true
        )

      on_log.(output)
      if exit_code != 0, do: raise("devcontainer build failed (exit #{exit_code})")
    after
      File.rm_rf!(work_dir)
    end
  end

  defp build_fallback(override_json, tag, on_log) do
    cfg =
      case Jason.decode(override_json || "{}") do
        {:ok, m} -> m
        _ -> %{}
      end

    base_image = cfg["base"] || "ubuntu:24.04"

    apt_packages =
      ((cfg["apt"] || []) ++ @always_packages)
      |> Enum.uniq()
      |> Enum.join(" ")

    env_lines =
      (cfg["env"] || %{})
      |> Enum.map(fn {k, v} -> "ENV #{k}=#{Jason.encode!(v)}" end)
      |> Enum.join("\n")

    dockerfile =
      @dockerfile_tmpl
      |> String.replace("__BASE_IMAGE__", base_image)
      |> String.replace("__APT_PACKAGES__", apt_packages)
      |> String.replace("__ENV_EXPORTS__", env_lines)

    tar = FBI.Orchestrator.Tar.build(%{"Dockerfile" => dockerfile})
    on_log.("[fbi] building base image #{tag}\n")

    case FBI.Docker.build_image(tar, tag, on_log) do
      :ok -> :ok
      {:error, err} -> raise "docker build failed: #{err}"
    end
  end

  defp build_post_layer(base_tag, final_tag, postbuild, on_log) do
    dockerfile = """
    FROM #{base_tag}
    USER root
    COPY postbuild.sh /tmp/postbuild.sh
    RUN bash /tmp/postbuild.sh && rm -f /tmp/postbuild.sh
    USER agent
    WORKDIR /workspace
    """

    tar =
      FBI.Orchestrator.Tar.build(%{
        "Dockerfile" => dockerfile,
        "postbuild.sh" => postbuild
      })

    on_log.("[fbi] applying post-build layer → #{final_tag}\n")

    case FBI.Docker.build_image(tar, final_tag, on_log) do
      :ok -> :ok
      {:error, err} -> raise "post-layer build failed: #{err}"
    end
  end
end
