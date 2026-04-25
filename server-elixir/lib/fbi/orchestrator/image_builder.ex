defmodule FBI.Orchestrator.ImageBuilder do
  @moduledoc "Port of src/server/orchestrator/image.ts."

  require Logger

  @always_packages ~w(git openssh-client gh ca-certificates claude-cli)

  @dockerfile_tmpl """
  FROM __BASE_IMAGE__

  ENV DEBIAN_FRONTEND=noninteractive
  RUN apt-get update && \\
      apt-get install -y --no-install-recommends ca-certificates curl gnupg __APT_PACKAGES__ && \\
      rm -rf /var/lib/apt/lists/*

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

        # The base build is supposed to tag base_tag. If it didn't, anything
        # further is doomed — fail loudly here rather than letting
        # build_post_layer 404 with a less useful "No such image" message.
        unless image_exists?(base_tag) do
          raise "image build for #{base_tag} reported success but the tag is not present"
        end
      end

      build_post_layer(base_tag, final_tag, postbuild, on_log)

      # Same guard for the post layer. We've been bitten by `stream_build_output`
      # returning :ok before Docker actually applied the `t=` tag (see fix in
      # docker.ex commit history). Verifying the tag landed catches that class
      # of bug at the source — the alternative is `create_container` 404ing
      # with "No such image: <tag>", which obscures where the build went wrong.
      unless image_exists?(final_tag) do
        raise "image build for #{final_tag} reported success but the tag is not present"
      end

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
    dc_part =
      if devcontainer_files do
        devcontainer_files
        |> Map.keys()
        |> Enum.sort()
        |> Enum.map_join("", fn k -> "#{k}:#{devcontainer_files[k]}\n" end)
      else
        ""
      end

    content =
      "dev:" <>
        dc_part <>
        "\nover:" <>
        (override_json || "") <>
        "\nalways:" <>
        (Enum.sort(@always_packages) |> Enum.join(",")) <>
        "\npostbuild:" <>
        postbuild

    :crypto.hash(:sha256, content)
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

      exit_code =
        stream_cmd(
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
          on_log
        )

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

    apt_packages = (cfg["apt"] || []) |> Enum.uniq() |> Enum.join(" ")

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

  # Run a command, streaming combined stdout/stderr to `on_log` chunk-by-chunk.
  # Returns the integer exit status. Used for the long-running devcontainer
  # build so progress reaches the UI as it happens, not after the build ends.
  defp stream_cmd(cmd, args, on_log) do
    bin = System.find_executable(cmd) || cmd

    port =
      Port.open(
        {:spawn_executable, bin},
        [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:args, args}
        ]
      )

    stream_loop(port, on_log)
  end

  defp stream_loop(port, on_log) do
    receive do
      {^port, {:data, chunk}} ->
        on_log.(chunk)
        stream_loop(port, on_log)

      {^port, {:exit_status, code}} ->
        code
    end
  end
end
