defmodule FBI.Terminal.Snapshot do
  @moduledoc "Returned by `FBI.Terminal.snapshot/1`."
  defstruct [:ansi, :cols, :rows, :byte_offset]
end

defmodule FBI.Terminal.ModePrefix do
  @moduledoc """
  Returned by `FBI.Terminal.snapshot_at/2`. ANSI escape sequences that
  reproduce the mode state at a given byte offset — prepended by the
  HTTP transcript Range API to chunk responses so xterm.js starts the
  chunk in the right buffer / scroll region / mode state.
  """
  defstruct [:ansi]
end

defmodule FBI.Terminal do
  @moduledoc """
  Rustler NIF wrapper around `fbi-term-core` (the Rust server-side
  virtual terminal).

  Each FBI run holds one parser handle. The handle is allocated by
  `FBI.Orchestrator.RunServer` on `set_container` and lives for the
  run's lifetime. ResourceArc GC reclaims it when the GenServer
  terminates.

  All functions are panic-safe: a Rust panic returns
  `{:error, :nif_panic}` rather than crashing the BEAM. A `:nif_panic`
  is a P0 bug — investigate.

  See `docs/superpowers/specs/2026-04-26-terminal-rust-rewrite-design.md`
  for design rationale.
  """
  use Rustler, otp_app: :fbi, crate: "fbi_term"

  @opaque handle :: reference()

  @spec new(pos_integer(), pos_integer()) :: handle()
  def new(_cols, _rows), do: :erlang.nif_error(:nif_not_loaded)

  @spec feed(handle(), binary()) :: :ok | {:error, :nif_panic}
  def feed(_handle, _bytes), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot(handle()) :: %FBI.Terminal.Snapshot{} | {:error, :nif_panic}
  def snapshot(_handle), do: :erlang.nif_error(:nif_not_loaded)

  @spec snapshot_at(handle(), non_neg_integer()) :: %FBI.Terminal.ModePrefix{} | {:error, :nif_panic}
  def snapshot_at(_handle, _offset), do: :erlang.nif_error(:nif_not_loaded)

  @spec resize(handle(), pos_integer(), pos_integer()) :: :ok | {:error, :nif_panic}
  def resize(_handle, _cols, _rows), do: :erlang.nif_error(:nif_not_loaded)
end
