# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :fbi,
  namespace: FBI,
  ecto_repos: [FBI.Repo],
  generators: [timestamp_type: :utc_datetime],
  credentials_path: Path.expand("~/.claude/.credentials.json")

config :fbi, proxy_target: "http://127.0.0.1:3001"

# CLI-binary serving config (Phase 2).  `cli_dist_dir` defaults to "dist/cli"
# for local dev; prod reads `CLI_DIST_DIR` in runtime.exs.  `fbi_cli_version`
# is surfaced via the `X-FBI-CLI-Version` response header when set.
config :fbi, cli_dist_dir: "dist/cli"
config :fbi, fbi_cli_version: nil

# Filesystem + secrets + docker for Phases 3–8.  Overridden per-environment
# in runtime.exs.  Defaults suit local dev / mix test.
config :fbi, runs_dir: Path.join(System.tmp_dir!(), "fbi-runs")
config :fbi, draft_uploads_dir: Path.join(System.tmp_dir!(), "fbi-draft-uploads")
config :fbi, secrets_key_path: Path.join(System.tmp_dir!(), "fbi-secrets.key")
config :fbi, docker_socket_path: "/var/run/docker.sock"

# Configure the endpoint
config :fbi, FBIWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: FBIWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: FBI.PubSub,
  live_view: [signing_salt: "3kEeyIl7"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
