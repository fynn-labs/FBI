defmodule FBI.Orchestrator.Viewer do
  @moduledoc """
  Per-WebSocket-connection state in a run's viewer registry.

  Each viewer gets:
    - `id`: opaque reference; allocated by RunServer on join.
    - `ws_pid`: the WebSocket handler process; monitored.
    - `ws_monitor_ref`: monitor ref so we can clean up on :DOWN.
    - `cols`, `rows`: dims this viewer last reported via hello/resize.
    - `focused_at`: monotonic timestamp of last focus event, or nil
      if this viewer has never had focus.
    - `joined_at`: monotonic timestamp at join.

  Held inside RunServer state (no separate process). Updates serialize
  through the GenServer's mailbox.
  """
  defstruct [:id, :ws_pid, :ws_monitor_ref, :cols, :rows, :focused_at, :joined_at]

  @type t :: %__MODULE__{
          id: reference(),
          ws_pid: pid(),
          ws_monitor_ref: reference(),
          cols: pos_integer(),
          rows: pos_integer(),
          focused_at: integer() | nil,
          joined_at: integer()
        }
end
