defmodule FBI.Repo do
  use Ecto.Repo,
    otp_app: :fbi,
    adapter: Ecto.Adapters.SQLite3
end
