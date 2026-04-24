defmodule FBIWeb.Router do
  use FBIWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", FBIWeb do
    pipe_through :api

    get "/usage", UsageController, :show
    get "/usage/daily", UsageController, :daily
    get "/usage/runs/:id", UsageController, :run_breakdown

    # Phase 2: settings + config + CLI download.
    # `POST /api/settings/run-gc` is *not* registered here — it stays proxied
    # to TS via the catch-all because it depends on the orchestrator (Phase 7).
    get "/settings", SettingsController, :show
    patch "/settings", SettingsController, :update
    get "/config/defaults", ConfigController, :defaults
    get "/cli/fbi-tunnel/:os/:arch", CliController, :fbi_tunnel

    get "/projects/:id/secrets", SecretsController, :index
    put "/projects/:id/secrets/:name", SecretsController, :put
    delete "/projects/:id/secrets/:name", SecretsController, :delete

    # Global MCP
    get "/mcp-servers", McpServersController, :index_global
    post "/mcp-servers", McpServersController, :create_global
    patch "/mcp-servers/:id", McpServersController, :patch_global
    delete "/mcp-servers/:id", McpServersController, :delete_global

    # Project-scoped MCP
    get "/projects/:id/mcp-servers", McpServersController, :index_project
    post "/projects/:id/mcp-servers", McpServersController, :create_project
    patch "/projects/:id/mcp-servers/:sid", McpServersController, :patch_project
    delete "/projects/:id/mcp-servers/:sid", McpServersController, :delete_project
  end

  # WebSocket upgrade routes must not go through the :api pipeline — the
  # `accepts ["json"]` plug rejects connections that don't carry a JSON
  # Content-Type header, which a WS upgrade request never does.
  scope "/api", FBIWeb do
    get "/ws/usage", UsageSocketController, :upgrade
  end

  # Enable LiveDashboard in development
  if Application.compile_env(:fbi, :dev_routes) do
    # If you want to use the LiveDashboard in production, you should put
    # it behind authentication and allow only admins to access it.
    # If your application does not have an admins-only section yet,
    # you can use Plug.BasicAuth to set up some basic authentication
    # as long as you are also using SSL (which you should anyway).
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through [:fetch_session, :protect_from_forgery]

      live_dashboard "/dashboard", metrics: FBIWeb.Telemetry
    end
  end

  # Catch-all: forward every unmatched request to the upstream server.
  # This must remain last so native routes above take precedence.
  match :*, "/*path", FBIWeb.ProxyRouter, :dispatch
end
