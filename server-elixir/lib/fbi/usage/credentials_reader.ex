defmodule FBI.Usage.CredentialsReader do
  @moduledoc """
  GenServer that watches the Anthropic OAuth credentials file and broadcasts
  `:credentials_changed` on the `"credentials"` PubSub topic whenever the file
  is modified.

  ## Why a GenServer?

  The process needs to hold two pieces of mutable state across its lifetime:
  the `FileSystem` watcher pid (so we can link its lifecycle to our own) and the
  current debounce timer reference (so we can cancel and reset it on each
  successive file event).

  ## Watching the directory, not the file

  Many editors and CLI tools (including `claude /login`) write credentials via an
  atomic rename: they write to a temp file and then `rename(2)` it into place.
  `inotify` does not fire `IN_MODIFY` on the target path during a rename; it fires
  `IN_MOVED_TO` on the *directory*. Watching the parent directory and filtering on
  the file's basename is therefore robust against both in-place writes and atomic
  rename dances.

  ## `read/1`

  A stateless module function that reads the credentials file from disk, parses
  the JSON, and returns the `claudeAiOauth.accessToken` string, or `nil` on any
  error (missing file, malformed JSON, missing/empty token). Callers that want the
  current token can call `read/1` directly without going through the GenServer.
  """

  use GenServer
  require Logger

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Starts the CredentialsReader GenServer.

  ## Options

    * `:path` (required) — absolute path to the credentials JSON file.
    * `:debounce_ms` — milliseconds to wait after the last file event before
      broadcasting. Defaults to `500`.
    * `:name` — registered name for the GenServer. Defaults to `__MODULE__`.
      Pass `nil` to skip registration (useful in tests where multiple instances
      may run concurrently).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)

    gen_opts =
      if name do
        [name: name]
      else
        []
      end

    GenServer.start_link(__MODULE__, opts, gen_opts)
  end

  @doc """
  Reads the credentials file at `path` and returns the OAuth access token, or
  `nil` on any error.

  This is a stateless helper — it performs a synchronous file read and JSON
  decode on the calling process. It does not interact with the GenServer.
  """
  @spec read(Path.t()) :: String.t() | nil
  def read(path) do
    with {:ok, raw} <- File.read(path),
         {:ok, obj} <- Jason.decode(raw),
         token when is_binary(token) and token != "" <-
           get_in(obj, ["claudeAiOauth", "accessToken"]) do
      token
    else
      _ -> nil
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    path = Keyword.fetch!(opts, :path)
    debounce_ms = Keyword.get(opts, :debounce_ms, 500)

    dir = Path.dirname(path)
    basename = Path.basename(path)

    # Ensure the directory exists so FileSystem has somewhere to attach.
    File.mkdir_p!(dir)

    # `FileSystem.start_link/1` returns `:ignore` when the OS-level watcher
    # (inotify on Linux, fsevents on macOS) can't start — most commonly when
    # `inotify-tools` isn't installed. Treat it the same as `{:error, _}`:
    # log and carry on without a watcher; the poller's scheduled cadence
    # still catches credential changes within five minutes.
    watcher =
      case FileSystem.start_link(dirs: [dir]) do
        {:ok, pid} ->
          FileSystem.subscribe(pid)
          pid

        other ->
          Logger.warning(
            "CredentialsReader: could not start file watcher for #{dir}: #{inspect(other)}. " <>
              "Credential changes will not be detected until the next scheduled poll."
          )

          nil
      end

    state = %{
      path: path,
      basename: basename,
      watcher: watcher,
      debounce_ms: debounce_ms,
      debounce_ref: nil
    }

    {:ok, state}
  end

  # File-change event for a specific path in the watched directory.
  @impl true
  def handle_info({:file_event, _pid, {file, _events}}, state) do
    if Path.basename(file) == state.basename do
      # Cancel any in-flight debounce timer, then start a fresh one.
      if state.debounce_ref, do: Process.cancel_timer(state.debounce_ref)
      ref = Process.send_after(self(), :emit, state.debounce_ms)
      {:noreply, %{state | debounce_ref: ref}}
    else
      {:noreply, state}
    end
  end

  # Debounce timer fired — broadcast the change event.
  @impl true
  def handle_info(:emit, state) do
    Phoenix.PubSub.broadcast(FBI.PubSub, "credentials", :credentials_changed)
    {:noreply, %{state | debounce_ref: nil}}
  end

  # Watcher process stopped (e.g. the watched directory was removed).
  @impl true
  def handle_info({:file_event, _pid, :stop}, state) do
    Logger.warning("CredentialsReader: file watcher stopped.")
    {:noreply, %{state | watcher: nil}}
  end
end
