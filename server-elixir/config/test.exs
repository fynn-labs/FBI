import Config

# Disable usage children in test to avoid conflicts with individually
# supervised test processes and to keep the test suite side-effect free.
config :fbi, credentials_path: false

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :fbi, FBI.Repo,
  database: Path.expand("../fbi_test.db", __DIR__),
  # SQLite has a single writer; async tests still run in parallel for non-DB
  # code, but serialise DB connections so concurrent writes don't race for
  # the file lock. Combined with the sandbox, this is the simplest correct
  # setup; bumping pool_size makes the suite flaky on `Database busy`.
  pool_size: 1,
  pool: Ecto.Adapters.SQL.Sandbox,
  busy_timeout: 5_000

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :fbi, FBIWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "RDpnfjidZYgldhMeejAzNq6GWgXY6DRdP1LygRC2Rdc0cqJ9oCzgpbh4Xniqk4u+",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
