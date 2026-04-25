defmodule FBI.DockerTest do
  use ExUnit.Case, async: false

  @moduletag :skip

  test "kill/1 no-ops on empty id" do
    assert :ok = FBI.Docker.kill("")
  end

  test "list_containers returns list" do
    {:ok, containers} = FBI.Docker.list_containers(all: true)
    assert is_list(containers)
  end

  test "list_images returns list" do
    {:ok, images} = FBI.Docker.list_images()
    assert is_list(images)
  end
end
