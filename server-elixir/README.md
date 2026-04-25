# FBI

## System requirements

On Linux hosts, install **`inotify-tools`** (e.g. `apt install inotify-tools`).
The orchestrator's `SafeguardWatcher` uses the `:file_system` package, which
shells out to `inotifywait` on Linux to watch the WIP git repo for changes.
Without it `FileSystem.start_link/1` returns `:ignore` and change-event
delivery degrades to a no-op (the watcher still emits the initial snapshot,
but won't react to subsequent file changes).

## Running

To start your Phoenix server:

* Run `mix setup` to install and setup dependencies
* Start Phoenix endpoint with `mix phx.server` or inside IEx with `iex -S mix phx.server`

Now you can visit [`localhost:4000`](http://localhost:4000) from your browser.

Ready to run in production? Please [check our deployment guides](https://hexdocs.pm/phoenix/deployment.html).

## Learn more

* Official website: https://www.phoenixframework.org/
* Guides: https://hexdocs.pm/phoenix/overview.html
* Docs: https://hexdocs.pm/phoenix
* Forum: https://elixirforum.com/c/phoenix-forum
* Source: https://github.com/phoenixframework/phoenix
