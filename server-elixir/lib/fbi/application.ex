defmodule FBI.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    credentials_path = Application.get_env(:fbi, :credentials_path)

    usage_children =
      if credentials_path do
        [
          {FBI.Usage.CredentialsReader, path: credentials_path},
          {FBI.Usage.Poller,
           token_fn: fn -> FBI.Usage.CredentialsReader.read(credentials_path) end}
        ]
      else
        []
      end

    children =
      [
        FBIWeb.Telemetry,
        FBI.Repo,
        {Ecto.Migrator,
         repos: Application.fetch_env!(:fbi, :ecto_repos), skip: skip_migrations?()},
        {DNSCluster, query: Application.get_env(:fbi, :dns_cluster_query) || :ignore},
        {Phoenix.PubSub, name: FBI.PubSub},
        {Registry, keys: :unique, name: FBI.Orchestrator.Registry},
        FBI.Orchestrator.RunSupervisor,
        {FBI.Orchestrator.ResumeScheduler,
         on_fire: &FBI.Orchestrator.resume/1, name: FBI.Orchestrator.ResumeScheduler},
        FBI.Github.StatusCache,
        FBI.Runs.ChangesCache,
        FBI.Housekeeping.DraftUploadsGc
      ] ++
        usage_children ++
        [
          FBIWeb.Endpoint
        ]

    opts = [strategy: :one_for_one, name: FBI.Supervisor]
    {:ok, pid} = Supervisor.start_link(children, opts)
    FBI.Orchestrator.recover()
    FBI.Orchestrator.rehydrate_schedules()
    {:ok, pid}
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    FBIWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  defp skip_migrations?() do
    # By default, sqlite migrations are run when using a release
    System.get_env("RELEASE_NAME") == nil
  end
end
