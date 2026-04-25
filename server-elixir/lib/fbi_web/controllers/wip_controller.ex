defmodule FBIWeb.WipController do
  use FBIWeb, :controller

  alias FBI.Orchestrator.WipRepo

  def show(conn, %{"id" => id}) do
    run_id = String.to_integer(id)
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

    with true <- WipRepo.exists?(runs_dir, run_id),
         snap when snap != nil <- WipRepo.snapshot_sha(runs_dir, run_id),
         files when files != [] <- WipRepo.read_snapshot_files(runs_dir, run_id) do
      parent = WipRepo.parent_sha(runs_dir, run_id) || ""
      json(conn, %{ok: true, snapshot_sha: snap, parent_sha: parent, files: files})
    else
      _ -> json(conn, %{ok: false, reason: "no-wip"})
    end
  end

  @safe_path ~r|^[\w./@:+-]+$|

  def file(conn, %{"id" => id} = params) do
    run_id = String.to_integer(id)
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")
    file_path = params["path"] || ""

    if file_path != "" and not Regex.match?(@safe_path, file_path) do
      conn |> put_status(400) |> json(%{error: "invalid path"})
    else
      result = WipRepo.read_snapshot_diff(runs_dir, run_id, file_path)
      json(conn, result)
    end
  end

  def patch(conn, %{"id" => id}) do
    run_id = String.to_integer(id)
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

    if WipRepo.exists?(runs_dir, run_id) do
      content = WipRepo.read_snapshot_patch(runs_dir, run_id)
      conn
      |> put_resp_content_type("text/plain")
      |> put_resp_header("content-disposition", "attachment; filename=\"run-#{run_id}-wip.patch\"")
      |> send_resp(200, content)
    else
      send_resp(conn, 404, "")
    end
  end

  def discard(conn, %{"id" => id}) do
    run_id = String.to_integer(id)
    runs_dir = Application.get_env(:fbi, :runs_dir, "/tmp/fbi-runs")

    if WipRepo.exists?(runs_dir, run_id) do
      WipRepo.delete_wip_ref(runs_dir, run_id)
      json(conn, %{ok: true})
    else
      conn |> put_status(404) |> json(%{ok: false})
    end
  end
end
