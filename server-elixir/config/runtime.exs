import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/fbi start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :fbi, FBIWeb.Endpoint, server: true
end

config :fbi, FBIWeb.Endpoint, http: [port: String.to_integer(System.get_env("PORT", "4000"))]

if config_env() == :prod do
  config :fbi, proxy_target: System.get_env("PROXY_TARGET", "http://127.0.0.1:3001")
  config :fbi, cli_dist_dir: System.get_env("CLI_DIST_DIR", "dist/cli")
  config :fbi, fbi_cli_version: System.get_env("FBI_VERSION")

  config :fbi, runs_dir: System.get_env("RUNS_DIR", "/var/lib/agent-manager/runs")

  config :fbi,
    draft_uploads_dir: System.get_env("DRAFT_UPLOADS_DIR", "/var/lib/agent-manager/draft-uploads")

  config :fbi,
    secrets_key_path: System.get_env("SECRETS_KEY_FILE", "/etc/agent-manager/secrets.key")

  config :fbi, docker_socket_path: System.get_env("DOCKER_SOCKET", "/var/run/docker.sock")

  # Look up the host system's "docker" group GID. The forwarded /var/run/docker.sock
  # bind-mount is owned by that GID, and the non-root `agent` user inside run
  # containers needs supplementary group membership matching it — otherwise
  # `docker` calls from the agent hit EACCES on the socket. The container spec
  # passes this value through as HostConfig.GroupAdd. HOST_DOCKER_GID overrides
  # autodetect; nil disables the GroupAdd entirely (e.g. in dev where docker-in-
  # docker isn't needed).
  lookup_host_docker_gid = fn ->
    case File.read("/etc/group") do
      {:ok, text} ->
        Enum.find_value(String.split(text, "\n"), fn line ->
          case String.split(line, ":") do
            ["docker", _, gid_str | _] ->
              case Integer.parse(gid_str) do
                {n, _} when n > 0 -> n
                _ -> nil
              end

            _ ->
              nil
          end
        end)

      _ ->
        nil
    end
  end

  host_docker_gid =
    case System.get_env("HOST_DOCKER_GID") do
      nil ->
        lookup_host_docker_gid.()

      "" ->
        lookup_host_docker_gid.()

      override ->
        case Integer.parse(override) do
          {n, _} when n >= 0 -> n
          _ -> nil
        end
    end

  config :fbi, host_docker_gid: host_docker_gid

  if credentials = System.get_env("CLAUDE_CREDENTIALS") do
    config :fbi, credentials_path: credentials
  end

  config :fbi,
    host_ssh_auth_sock:
      System.get_env("HOST_SSH_AUTH_SOCK") || System.get_env("SSH_AUTH_SOCK")

  database_path =
    System.get_env("DATABASE_PATH") ||
      raise """
      environment variable DATABASE_PATH is missing.
      For example: /etc/fbi/fbi.db
      """

  config :fbi, FBI.Repo,
    database: database_path,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5"),
    # The production DB is shared between this server and the agent runtime,
    # so concurrent writes happen. Retry briefly instead of erroring.
    busy_timeout: 5_000

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  config :fbi, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  config :fbi, FBIWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      # Enable IPv6 and bind on all interfaces.
      # Set it to  {0, 0, 0, 0, 0, 0, 0, 1} for local network only access.
      # See the documentation on https://hexdocs.pm/bandit/Bandit.html#t:options/0
      # for details about using IPv6 vs IPv4 and loopback vs public addresses.
      ip: {0, 0, 0, 0, 0, 0, 0, 0}
    ],
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :fbi, FBIWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://hexdocs.pm/plug/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :fbi, FBIWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end
