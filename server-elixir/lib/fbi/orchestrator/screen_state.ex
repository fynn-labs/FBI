defmodule FBI.Orchestrator.ScreenState do
  @moduledoc """
  Per-run ring buffer of raw terminal bytes. Snapshot = clear-screen + tail bytes.
  ETS table :fbi_screen_state, key = run_id, value = binary (last @cap bytes).
  """

  @table :fbi_screen_state
  @cap 512 * 1024
  @clear_screen "\e[2J\e[H"

  def ensure_started do
    if :ets.whereis(@table) == :undefined do
      :ets.new(@table, [
        :named_table,
        :public,
        :set,
        read_concurrency: true,
        write_concurrency: true
      ])
    end

    :ok
  end

  def feed(run_id, chunk) when is_binary(chunk) do
    ensure_started()

    current =
      case :ets.lookup(@table, run_id) do
        [{_, buf}] -> buf
        [] -> ""
      end

    combined = current <> chunk

    trimmed =
      if byte_size(combined) > @cap do
        :binary.part(combined, byte_size(combined) - @cap, @cap)
      else
        combined
      end

    :ets.insert(@table, {run_id, trimmed})
    :ok
  end

  def snapshot(run_id) do
    ensure_started()

    buf =
      case :ets.lookup(@table, run_id) do
        [{_, b}] -> b
        [] -> ""
      end

    @clear_screen <> buf
  end

  def clear(run_id) do
    ensure_started()
    :ets.delete(@table, run_id)
    :ok
  end

  def resize(_run_id, _cols, _rows), do: :ok
end
