defmodule FBIWeb.Router do
  use FBIWeb, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", FBIWeb do
    pipe_through :api

    get "/health", HealthController, :show

    get "/usage", UsageController, :show
    get "/usage/daily", UsageController, :daily
    get "/usage/runs/:id", UsageController, :run_breakdown

    # Phase 2: settings + config + CLI download.
    get "/settings", SettingsController, :show
    patch "/settings", SettingsController, :update
    post "/settings/run-gc", SettingsController, :run_gc
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

    # Phase 3+4+5+6+8 routes.
    get "/projects", ProjectsController, :index
    post "/projects", ProjectsController, :create
    get "/projects/:id", ProjectsController, :show
    patch "/projects/:id", ProjectsController, :update
    delete "/projects/:id", ProjectsController, :delete
    get "/projects/:id/prompts/recent", ProjectsController, :recent_prompts

    get "/runs", RunsController, :index
    get "/runs/:id", RunsController, :show
    patch "/runs/:id", RunsController, :patch_title
    delete "/runs/:id", RunsController, :delete
    get "/runs/:id/siblings", RunsController, :siblings
    get "/runs/:id/listening-ports", ProxyController, :listening_ports
    post "/runs/:id/continue", RunsController, :continue_run
    post "/runs/:id/resume-now", RunsController, :resume_now
    get "/projects/:id/runs", RunsController, :index_for_project
    post "/projects/:id/runs", RunsController, :create

    get "/runs/:id/transcript", TranscriptController, :show
    get "/runs/:id/files", FilesController, :show

    get "/runs/:id/wip", WipController, :show
    get "/runs/:id/wip/file", WipController, :file
    get "/runs/:id/wip/patch", WipController, :patch
    post "/runs/:id/wip/discard", WipController, :discard

    post "/runs/:id/history", HistoryController, :create

    get "/runs/:id/changes", ChangesController, :show
    get "/runs/:id/commits/:sha/files", ChangesController, :commit_files
    get "/runs/:id/submodule/*path", ChangesController, :submodule_files
    get "/runs/:id/file-diff", FileDiffController, :show

    get "/runs/:id/github", GithubController, :show
    post "/runs/:id/github/pr", GithubController, :create_pr
    post "/runs/:id/github/merge", GithubController, :merge

    get "/runs/:id/uploads", UploadsController, :index
    post "/runs/:id/uploads", UploadsController, :create
    delete "/runs/:id/uploads/:filename", UploadsController, :delete

    post "/draft-uploads", DraftUploadsController, :create
    delete "/draft-uploads/:token/:filename", DraftUploadsController, :delete
  end

  # WebSocket upgrade routes must not go through the :api pipeline — the
  # `accepts ["json"]` plug rejects connections that don't carry a JSON
  # Content-Type header, which a WS upgrade request never does.
  scope "/api", FBIWeb do
    get "/ws/usage", UsageSocketController, :upgrade
    get "/ws/states", StatesSocketController, :upgrade
    get "/runs/:id/shell", ShellSocketController, :upgrade
    get "/runs/:id/proxy/:port", ProxySocketController, :upgrade
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
