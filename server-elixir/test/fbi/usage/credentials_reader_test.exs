defmodule FBI.Usage.CredentialsReaderTest do
  use ExUnit.Case, async: false

  alias FBI.Usage.CredentialsReader

  setup do
    tmp =
      System.tmp_dir!()
      |> Path.join("creds-#{:erlang.unique_integer([:positive])}.json")

    on_exit(fn -> File.rm_rf(tmp) end)
    {:ok, %{path: tmp}}
  end

  # ---------------------------------------------------------------------------
  # read/1 — stateless helper
  # ---------------------------------------------------------------------------

  describe "read/1" do
    test "returns nil when file does not exist", %{path: path} do
      assert CredentialsReader.read(path) == nil
    end

    test "returns the access token from a valid JSON file", %{path: path} do
      payload = Jason.encode!(%{"claudeAiOauth" => %{"accessToken" => "tok_abc123"}})
      File.write!(path, payload)
      assert CredentialsReader.read(path) == "tok_abc123"
    end

    test "returns nil for malformed JSON", %{path: path} do
      File.write!(path, "not json {{{")
      assert CredentialsReader.read(path) == nil
    end

    test "returns nil when claudeAiOauth key is missing", %{path: path} do
      File.write!(path, Jason.encode!(%{"other" => "stuff"}))
      assert CredentialsReader.read(path) == nil
    end

    test "returns nil when accessToken key is missing", %{path: path} do
      File.write!(path, Jason.encode!(%{"claudeAiOauth" => %{"other" => "x"}}))
      assert CredentialsReader.read(path) == nil
    end

    test "returns nil when accessToken is an empty string", %{path: path} do
      File.write!(path, Jason.encode!(%{"claudeAiOauth" => %{"accessToken" => ""}}))
      assert CredentialsReader.read(path) == nil
    end

    test "returns nil when accessToken is null", %{path: path} do
      File.write!(path, Jason.encode!(%{"claudeAiOauth" => %{"accessToken" => nil}}))
      assert CredentialsReader.read(path) == nil
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer — file-watch + PubSub broadcast
  # ---------------------------------------------------------------------------

  describe "GenServer broadcast" do
    test "broadcasts :credentials_changed after a file write", %{path: path} do
      Phoenix.PubSub.subscribe(FBI.PubSub, "credentials")

      start_supervised!({CredentialsReader, path: path, debounce_ms: 50, name: nil})

      # Give the inotify watch a moment to arm before writing.
      Process.sleep(200)

      payload = Jason.encode!(%{"claudeAiOauth" => %{"accessToken" => "new_token"}})
      File.write!(path, payload)

      assert_receive :credentials_changed, 3_000
    end

    test "coalesces rapid writes into a single broadcast", %{path: path} do
      Phoenix.PubSub.subscribe(FBI.PubSub, "credentials")

      # Long debounce gives slower CI runners enough slack to deliver all
      # inotify events before the window closes, without which the first
      # few writes can fire a debounce while the later writes arrive late
      # and fire a second one.
      start_supervised!({CredentialsReader, path: path, debounce_ms: 500, name: nil})

      # Give the inotify watch a moment to arm before writing.
      Process.sleep(200)

      payload = Jason.encode!(%{"claudeAiOauth" => %{"accessToken" => "v1"}})

      # All writes land well inside the debounce window.
      for _ <- 1..5 do
        File.write!(path, payload)
        Process.sleep(5)
      end

      assert_receive :credentials_changed, 3_000

      # Confirm no second broadcast lands within the full debounce window.
      refute_receive :credentials_changed, 700
    end
  end
end
