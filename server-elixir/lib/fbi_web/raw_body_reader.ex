defmodule FBIWeb.RawBodyReader do
  @moduledoc """
  Body reader that reads the request body and stashes a copy on
  `conn.assigns[:raw_body]` before returning it.

  Wired into `Plug.Parsers` via the `:body_reader` option so the parsed params
  remain available for native controllers while the proxy plug can still
  retrieve the original bytes for forwarding to upstream. Without this, the
  parser consumes the body and the proxy reads empty, stripping POST/PUT/PATCH
  bodies silently.
  """

  @doc """
  Drop-in replacement for `Plug.Conn.read_body/2` that caches what it reads.

  The cached body is a list of chunks (newest first) built up across the
  parser's potentially multiple `read_body` calls. The proxy collapses it with
  `IO.iodata_to_binary/1`.
  """
  def read_body(conn, opts) do
    case Plug.Conn.read_body(conn, opts) do
      {:ok, chunk, conn} ->
        acc = [chunk | Map.get(conn.assigns, :raw_body, [])]
        {:ok, chunk, Plug.Conn.assign(conn, :raw_body, acc)}

      {:more, chunk, conn} ->
        acc = [chunk | Map.get(conn.assigns, :raw_body, [])]
        {:more, chunk, Plug.Conn.assign(conn, :raw_body, acc)}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
